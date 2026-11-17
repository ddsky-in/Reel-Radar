import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('Deno', { env: { get: () => undefined }, serve: vi.fn() });
const dispatcher = await import('../supabase/functions/refresh-dispatch/index.ts' as string);
const reconciler = await import('../supabase/functions/reconcile-jobs/index.ts' as string);
const webhook = await import('../supabase/functions/apify-webhook/index.ts' as string);
const owner = 'cf100000-0000-4000-8000-000000000001';
const selected = 'cf100000-0000-4000-8000-000000000002';
const creator = 'cf100000-0000-4000-8000-000000000003';
const nonce = 'cf100000-0000-4000-8000-000000000004';
const lease = 'cf100000-0000-4000-8000-000000000005';
const otherCreator = 'cf100000-0000-4000-8000-000000000006';
let values: Record<string, string>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let context: { job: Record<string, unknown>; creators: { id: string; username: string }[] };
let claims: unknown[], dataset: unknown[], violations: string[];
let run: Record<string, unknown>;
let queueProfile: boolean, claimedProfile: boolean, allowStart: boolean;
const response = (data: unknown) => Response.json(data);
const request = (payload: unknown, secret = 'internal', header = 'x-internal-secret') => new Request('https://fixture.test', {
  method: 'POST', headers: { 'content-type': 'application/json', [header]: secret }, body: JSON.stringify(payload),
});
const calls = (name: string) => fetcher.mock.calls.filter(([url]) => String(url).endsWith(`/rpc/${name}`));
const args = (name: string) => JSON.parse(String(calls(name)[0]?.[1]?.body));
const starts = () => fetcher.mock.calls.filter(([url, init]) => String(url).includes('/actors/') && init?.method === 'POST');
const noMaintenance = () => {
  expect(calls('worker_profile_maintain')).toHaveLength(0);
  expect(calls('worker_competitor_maintain')).toHaveLength(0);
  expect(calls('worker_carousel_maintain')).toHaveLength(0);
};

beforeEach(() => {
  values = { PROVIDER_MODE: 'apify', APIFY_REEL_ACTOR_RESOURCE_ID: 'reel-actor', APIFY_PROFILE_ACTOR_RESOURCE_ID: 'profile-actor',
    APIFY_API_TOKEN: 'synthetic-token', APIFY_ACCOUNT_ID: 'account', APIFY_WEBHOOK_SHARED_SECRET: 'webhook',
    SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INTERNAL_CRON_SECRET: 'internal',
    REELRADAR_OWNER_USER_ID: owner, SCRAPING_ENABLED: 'true', PROVIDER_VALIDATED: 'true', RUN_CHARGE_CAP_VALIDATED: 'true',
    ACCOUNT_USAGE_VALIDATED: 'true', PROFILE_PROVIDER_VALIDATED: 'true', CAROUSEL_PROVIDER_VALIDATED: 'true', CAROUSEL_PILOT_JOB_ID: selected };
  context = { job: { id: selected, owner_user_id: owner, kind: 'profile', collection_source: 'ordinary', live: true, status: 'processing',
    profile_automatic: true, profile_automation_scheduled_at: '2026-11-15T10:00:00Z', manual_authorized_by: owner, requested_profiles_count: 1, results_limit: 1,
    reserved_usd: .1, expected_actor_id: 'profile-actor', expected_provider_user_id: 'account', dispatch_nonce: nonce, lease_token: lease,
    actor_run_id: 'accepted', dataset_id: 'dataset', dataset_cursor: 0, dataset_finished: false, started_at: '2026-11-15T10:00:00Z',
    result_fetched_at: '2026-11-15T10:01:00Z', actual_cost_usd: null, provider_terminal_status: 'SUCCEEDED' },
    creators: [{ id: creator, username: 'fixture' }] };
  run = { id: 'accepted', actId: 'profile-actor', userId: 'account', status: 'SUCCEEDED', defaultDatasetId: 'dataset',
    defaultKeyValueStoreId: 'store', usageTotalUsd: null };
  dataset = [{ username: 'fixture', followersCount: 123, fullName: 'Synthetic profile fixture', profilePicUrl: 'https://scontent.cdninstagram.com/fixture.jpg' }];
  claims = []; violations = []; queueProfile = false; claimedProfile = false; allowStart = false;
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] }, serve: vi.fn() });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  // No transport fallback: every database/provider response below is synthetic and inert.
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://fixture.supabase.co') {
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBe('synthetic-service');
      expect(headers.get('authorization')).toBe('Bearer synthetic-service');
      if (url.pathname === '/rest/v1/scrape_jobs') return response([context.job]);
      if (url.pathname === '/rest/v1/scrape_job_creators') return response(context.creators.map(creators => ({ creators })));
      const name = url.pathname.replace('/rest/v1/rpc/', '');
      const payload = JSON.parse(String(init?.body));
      if (payload.p_owner_user_id !== undefined) expect(payload.p_owner_user_id).toBe(owner);
      if (name === 'worker_configure_profile_automation') return response({ enabled: payload.p_enabled });
      if (name === 'worker_accounts') return response([{ owner_user_id: owner, account_slot: 1, provider_user_id: 'account', enabled: true, authorization_confirmed: true }]);
      if (name === 'worker_begin_account_usage') return response({ observation_id: nonce, observed_at: new Date().toISOString() });
      if (name === 'worker_claim_collection_executor') return response({ max_active: 3, max_starts_per_wake: 3, wake_revision: 1,
        drained_revision: 0, wake_pending: true, eligible_kinds: ['daily', 'profile'], executor_nonce: lease, executor_revision: 1,
        executor_expires_at: new Date(Date.now() + 90000).toISOString(), executor_starts: 0, executor_start_limit: 3,
        wake_retry_after: null, claimed_revision: 1, starts_remaining: 3 });
      if (name === 'worker_claim_next') {
        if (queueProfile && !claimedProfile) { claimedProfile = true; return response({ ...structuredClone(context), max_total_charge_usd: .1 }); }
        return response({ reason: 'no_pending_jobs' });
      }
      if (['worker_release_collection_executor', 'worker_drain_completion_wake', 'worker_renew_collection_executor', 'worker_record_completion_wake'].includes(name)) return response(true);
      if (name === 'worker_claim_reconciliation') return response(structuredClone(claims));
      if (name === 'worker_claim_processing') return response(structuredClone(context));
      if (name === 'worker_reconcile_run') return response(structuredClone(context.job));
      if (name === 'worker_isolate_collection_settlement') { context.job.collection_source = 'operator_settle'; return response(null); }
      if (name === 'worker_claim_carousel_pilot') return response({ reason: 'pilot_job_not_pending' });
      if (name === 'worker_transcription_media_reconcile') return response({ status: 'not_linked' });
      if (name === 'worker_record_callback_receipt') return response({ accepted: true });
      if (name === 'worker_get_collection_recovery_state') return response({ input_digest: null, accepted_evidence: [], callback_hints: [] });
      if (name === 'worker_record_accepted_evidence') return response({ recorded: true });
      if (name === 'worker_authorize_collection_submit') return response({ authorized: true });
      if (name === 'worker_cancel_pre_submit') return response({ cancelled: true });
      if (name === 'worker_claim_missing_run_recovery') return response([]);
      if (['worker_profile_maintain', 'worker_competitor_maintain', 'worker_carousel_maintain', 'worker_expire_dispatches', 'worker_schedule',
        'worker_record_usage', 'worker_attach_run', 'worker_complete_reconciliation', 'worker_ingest_page', 'worker_record_output_summary',
        'worker_finish_processing'].includes(name)) return response(null);
    }
    if (url.origin === 'https://api.apify.com') {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
      if (init?.method !== 'POST') {
        if (url.pathname === '/v2/users/me') return response({ data: { id: 'account' } });
        if (url.pathname === '/v2/users/me/limits') return response({ data: { monthlyUsageCycle: {
          startAt: new Date(Date.now() - 86400000).toISOString(), endAt: new Date(Date.now() + 86400000).toISOString(),
        }, current: { monthlyUsageUsd: 0 }, limits: { maxMonthlyUsageUsd: 5 } } });
        if (url.pathname === '/v2/actor-runs/accepted') return response({ data: run });
        if (url.pathname === '/v2/key-value-stores/store/records/OUTPUT') return response({ synthetic: true });
        if (url.pathname === '/v2/datasets/dataset/items') return response(dataset);
      }
      if (allowStart && url.pathname === '/v2/actors/profile-actor/runs' && init?.method === 'POST') return response({ data: { ...run, status: 'RUNNING' } });
    }
    violations.push(`Unexpected fixture transport ${url.origin}${url.pathname}`);
    throw new Error('Unexpected fixture transport');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  try { expect(violations).toEqual([]); expect(starts()).toHaveLength(allowStart ? 1 : 0); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe('daily combined profile maintenance in generic wakes only', () => {
  it.each(['dispatch', 'reconcile'])('queues one owner-bounded20 batch before generic %s dispatch and existing monetary gates', async endpoint => {
    expect((await (endpoint === 'dispatch' ? dispatcher.handler : reconciler.handler)(request({ continuation_budget: 0 }))).status).toBe(200);
    expect(calls('worker_profile_maintain')).toHaveLength(1);
    expect(args('worker_profile_maintain')).toEqual({ p_owner_user_id: owner, p_limit: 20 });
    const order = fetcher.mock.calls.map(([url]) => String(url));
    const index = (name: string) => order.findIndex(url => url.endsWith(`/rpc/${name}`));
    expect(index('worker_claim_collection_executor')).toBeLessThan(index('worker_profile_maintain'));
    expect(index('worker_claim_collection_executor')).toBeLessThan(index('worker_begin_account_usage'));
    expect(index('worker_record_usage')).toBeLessThan(index('worker_claim_next'));
    expect(args('worker_claim_next')).toMatchObject({ p_owner_user_id: owner, p_eligible_kinds: ['daily', 'profile'],
      p_actor_ids: { daily: 'reel-actor', profile: 'profile-actor' }, p_executor_nonce: lease, p_claimed_revision: 1 });
    expect(calls('worker_claim_next')).toHaveLength(1);
    expect(calls('worker_schedule')).toHaveLength(0);
    expect(calls('worker_install_competitor_schedules')).toHaveLength(0);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/scrape_jobs?'))).toBe(false);
  });
  it.each([undefined, 'false', 'TRUE', 'True', '1', ' true '])('never maintains profiles without exact validation: %s', async gate => {
    if (gate === undefined) delete values.PROFILE_PROVIDER_VALIDATED; else values.PROFILE_PROVIDER_VALIDATED = gate;
    for (const handler of [dispatcher.handler, reconciler.handler]) expect((await handler(request({ continuation_budget: 0 }))).status).toBe(200);
    expect(calls('worker_profile_maintain')).toHaveLength(0);
    expect(args('worker_claim_next').p_eligible_kinds).toEqual(['daily']);
  });
  it.each(['daily', 'weekly', 'profile', 'retry', 'discovery', 'metrics'])('does not add profiles to a scoped %s refresh', async kind => {
    expect((await dispatcher.handler(request({ kind, continuation_budget: 0 }))).status).toBe(200);
    expect(calls('worker_profile_maintain')).toHaveLength(0);
    expect(args('worker_schedule')).toEqual({ p_owner_user_id: owner, p_kind: kind });
  });
  it.each(['dispatch', 'reconcile'])('fails closed before dispatch if profile maintenance fails during %s', async endpoint => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).endsWith('/worker_profile_maintain')
      ? Promise.resolve(new Response('private upstream detail', { status: 503 })) : original(url, init));
    const result = await (endpoint === 'dispatch' ? dispatcher.handler : reconciler.handler)(request({ continuation_budget: 0 }));
    expect(result.status).toBe(503);
    expect(JSON.stringify(await result.json())).not.toContain('private upstream detail');
    expect(calls('worker_claim_collection_executor')).toHaveLength(1);
    expect(calls('worker_release_collection_executor')).toHaveLength(1);
    expect(calls('worker_claim_next')).toHaveLength(0);
  });
  it.each([{ carousel_pilot_job_id: selected }, { settle_job_id: selected }, { ordinary_callback_job_id: selected }])(
    'does not maintain any extra profile on a scoped reconciliation/retry: %j', async scope => {
      expect((await reconciler.handler(request({ ...scope, continuation_budget: 0 }))).status).toBe(200);
      noMaintenance();
      expect(calls('worker_expire_dispatches')).toHaveLength(0);
      expect(args('worker_claim_reconciliation')).toMatchObject({ p_owner_user_id: owner, p_job_id: selected, p_limit: 10 });
    },
  );
  it.each(['diagnostics', 'inspect_run', 'carousel_pilot'])('never adds profiles during %s', async action => {
    const result = await dispatcher.handler(request({ action, run_id: 'accepted', job_id: selected, continuation_budget: 0 }));
    expect(result.status).toBe(200); noMaintenance();
    expect(calls('worker_claim_collection_executor')).toHaveLength(0);
    expect(calls('worker_claim_next')).toHaveLength(0);
  });
  it.each(['dispatch', 'reconcile'])('requires strict internal authentication before %s maintenance', async endpoint => {
    const handler = endpoint === 'dispatch' ? dispatcher.handler : reconciler.handler;
    for (const input of [request({}, 'wrong'), request({}, 'webhook', 'x-webhook-secret'), request({}, 'Bearer synthetic-service', 'authorization'),
      new Request('https://fixture.test', { headers: { 'x-internal-secret': 'internal' } })]) expect((await handler(input)).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('dispatches a durably marked job with the existing minimal combined input, never a photo-only call', async () => {
    queueProfile = true; allowStart = true;
    context.job.status = 'dispatching'; context.job.actor_run_id = null; context.job.provider_terminal_status = null;
    const result = await dispatcher.handler(request({ continuation_budget: 0 }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ outcomes: [{ job_id: selected, status: 'running' }, { reason: 'no_pending_jobs' }] });
    expect(starts()).toHaveLength(1);
    expect(JSON.parse(String(starts()[0][1]?.body))).toEqual({ proxyConfiguration: { useApifyProxy: true }, usernames: ['fixture'],
      mode: 'profiles', maxResults: 1, includeLatestPosts: false, includeReels: false, includeContactDetails: false,
      includeStats: true, includeDetails: true, includeProfileRecord: true, includeVideoViews: false, includeCompatibilityKeys: false });
    expect(new URL(String(starts()[0][0])).searchParams.get('maxTotalChargeUsd')).toBe('0.1');
    expect(args('worker_attach_run')).toMatchObject({ p_job_id: selected, p_dispatch_nonce: nonce, p_actor_id: 'profile-actor', p_run_id: 'accepted' });
    expect(calls('worker_profile_maintain')).toHaveLength(1);
  });
});

describe('explicit service-only profile automation configuration', () => {
  it.each([true, false])('configures enabled=%s without enqueue, usage reconciliation or provider reads', async enabled => {
    const result = await dispatcher.handler(request({ action: 'configure_profile_automation', enabled }));
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ automation: { enabled } });
    expect(args('worker_configure_profile_automation')).toEqual({ p_owner_user_id: owner, p_enabled: enabled, p_provider_validated: true });
    expect(fetcher).toHaveBeenCalledTimes(1); noMaintenance();
  });
  it('permits an authorized disable with provider and paid-start gates closed', async () => {
    for (const name of ['PROFILE_PROVIDER_VALIDATED', 'SCRAPING_ENABLED', 'PROVIDER_VALIDATED', 'RUN_CHARGE_CAP_VALIDATED', 'ACCOUNT_USAGE_VALIDATED',
      'APIFY_API_TOKEN', 'APIFY_ACCOUNT_ID', 'APIFY_PROFILE_ACTOR_RESOURCE_ID', 'APIFY_REEL_ACTOR_RESOURCE_ID', 'APIFY_WEBHOOK_SHARED_SECRET']) delete values[name];
    expect((await dispatcher.handler(request({ action: 'configure_profile_automation', enabled: false }))).status).toBe(200);
    expect(args('worker_configure_profile_automation')).toEqual({ p_owner_user_id: owner, p_enabled: false, p_provider_validated: false });
    expect(fetcher).toHaveBeenCalledTimes(1); noMaintenance();
  });
  it.each(['PROFILE_PROVIDER_VALIDATED', 'SCRAPING_ENABLED', 'PROVIDER_VALIDATED', 'RUN_CHARGE_CAP_VALIDATED', 'ACCOUNT_USAGE_VALIDATED',
    'APIFY_API_TOKEN', 'APIFY_ACCOUNT_ID', 'APIFY_PROFILE_ACTOR_RESOURCE_ID', 'APIFY_REEL_ACTOR_RESOURCE_ID', 'APIFY_WEBHOOK_SHARED_SECRET',
    'PROVIDER_MODE', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])('rejects enable before transport without %s', async name => {
    delete values[name];
    expect((await dispatcher.handler(request({ action: 'configure_profile_automation', enabled: true }))).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['false', 'TRUE', 'True', '1', ' true '])('requires an exact profile validation flag to enable: %s', async gate => {
    values.PROFILE_PROVIDER_VALIDATED = gate;
    expect((await dispatcher.handler(request({ action: 'configure_profile_automation', enabled: true }))).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects enable in an otherwise valid isolated mock runtime', async () => {
    values.PROVIDER_MODE = 'mock'; values.ENVIRONMENT = 'test'; values.SUPABASE_URL = 'http://127.0.0.1:54321';
    expect((await dispatcher.handler(request({ action: 'configure_profile_automation', enabled: true }))).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { PROFILE_INPUT_BASE_JSON: '[]' }, { PROFILE_INPUT_FORMAT: 'directUrls' }, { PROFILE_INPUT_USERNAMES_KEY: 'directUrls' },
    { PROFILE_OUTPUT_MAPPING_JSON: '{' }, { PROFILE_OUTPUT_MAPPING_JSON: '{"username":"username"}' },
    { PROFILE_OUTPUT_MAPPING_JSON: '{"username":"username","followers":"constructor.value"}' },
  ])('validates existing profile input/output setup before configuration: %j', async patch => {
    Object.assign(values, patch);
    expect((await dispatcher.handler(request({ action: 'configure_profile_automation', enabled: true }))).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'true', 'false', 1, 0, {}, []])('requires boolean enabled, not coercion: %j', async enabled => {
    expect((await dispatcher.handler(request({ action: 'configure_profile_automation', enabled }))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ provider_validated: true }, { p_provider_validated: true }, { owner_user_id: creator }, { kind: 'profile' },
    { continuation_budget: 0 }, { job_id: selected }, { token: 'not-authorized' }])('rejects caller validation/scope/body overrides: %j', async extra => {
    expect((await dispatcher.handler(request({ action: 'configure_profile_automation', enabled: true, ...extra }))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects array/coerced actions instead of falling through to a dispatch', async () => {
    expect((await dispatcher.handler(request({ action: ['configure_profile_automation'], enabled: true }))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires internal header authentication, including a configured nonempty secret', async () => {
    for (const input of [request({ action: 'configure_profile_automation', enabled: false }, 'wrong'),
      request({ action: 'configure_profile_automation', enabled: false }, 'webhook', 'x-webhook-secret'),
      request({ action: 'configure_profile_automation', enabled: false }, 'Bearer synthetic-service', 'authorization')]) expect((await dispatcher.handler(input)).status).toBe(401);
    delete values.INTERNAL_CRON_SECRET;
    expect((await dispatcher.handler(request({ action: 'configure_profile_automation', enabled: false }))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([undefined, 'invalid', creator.replaceAll('-', '')])('requires a valid configured owner even when disabling: %s', async id => {
    if (id === undefined) delete values.REELRADAR_OWNER_USER_ID; else values.REELRADAR_OWNER_USER_ID = id;
    expect((await dispatcher.handler(request({ action: 'configure_profile_automation', enabled: false }))).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('marked combined profile callback/retry uses existing partial completion', () => {
  it.each(['callback', 'scoped_retry'])('preserves valid combined data on %s without maintaining or starting extra profiles', async endpoint => {
    context.creators.push({ id: otherCreator, username: 'second' });
    context.job.requested_profiles_count = 2;
    dataset.push({ username: 'second', followersCount: null, fullName: 'Missing followers fixture' });
    claims = [{ job: context.job, callback_hint: { run_id: 'accepted', dispatch_nonce: nonce }, reconciliation_token: lease }];
    const result = endpoint === 'callback' ? await webhook.handler(new Request(`https://fixture.test/apify-webhook?job_id=${selected}&dispatch_nonce=${nonce}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 'webhook' }, body: JSON.stringify({ run_id: 'accepted' }),
    })) : await reconciler.handler(request({ ordinary_callback_job_id: selected, continuation_budget: 0 }));
    expect(result.status).toBe(200); noMaintenance();
    expect(args('worker_ingest_page')).toMatchObject({ p_job_id: selected, p_records: [{ creator_id: creator, followers_count: 123,
      display_name: 'Synthetic profile fixture', avatar_url: 'https://scontent.cdninstagram.com/fixture.jpg', fetched_at: '2026-11-15T10:01:00Z' }],
      p_errors: [{ creator_id: otherCreator, status: 'failed' }], p_received_counts: { [creator]: 1, [otherCreator]: 1 } });
    expect(args('worker_ingest_page').p_records).toHaveLength(1);
    expect(args('worker_reconcile_run').p_usage_total_usd).toBeNull();
    expect(args('worker_record_output_summary').p_summary).toMatchObject({ complete: false, reason: 'profile_output_contract_unverified' });
    expect(calls('worker_finish_processing')).toHaveLength(1);
    expect(args('worker_record_completion_wake')).toEqual({ p_owner_user_id: owner, p_job_id: selected });
    expect(args('worker_claim_collection_executor').p_completion_only).toBe(true);
    expect(args('worker_complete_reconciliation')).toMatchObject({ p_owner_user_id: owner, p_job_id: selected, p_callback_state: 'verified' });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/datasets/'))).toHaveLength(1);
  });
});
