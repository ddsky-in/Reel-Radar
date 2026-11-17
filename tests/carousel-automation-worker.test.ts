import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('Deno', { env: { get: () => undefined }, serve: vi.fn() });
const providers = await import('../supabase/functions/_shared/providers.ts' as string);
const worker = await import('../supabase/functions/_shared/worker.ts' as string);
const dispatcher = await import('../supabase/functions/refresh-dispatch/index.ts' as string);
const reconciler = await import('../supabase/functions/reconcile-jobs/index.ts' as string);
const webhook = await import('../supabase/functions/apify-webhook/index.ts' as string);
const owner = 'cc100000-0000-4000-8000-000000000001';
const selected = 'cc100000-0000-4000-8000-000000000002';
const creator = 'cc100000-0000-4000-8000-000000000003';
const nonce = 'cc100000-0000-4000-8000-000000000004';
const lease = 'cc100000-0000-4000-8000-000000000005';
let values: Record<string, string>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let context: { job: Record<string, unknown>; creators: { id: string; username: string }[] };
let run: Record<string, unknown>;
let output: Record<string, unknown>;
let dataset: unknown[];
let claims: unknown[];
let violations: string[];
const response = (data: unknown) => new Response(JSON.stringify(data));
const request = (payload: unknown, secret = 'internal', header = 'x-internal-secret') => new Request('https://fixture.test', {
  method: 'POST', headers: { 'content-type': 'application/json', [header]: secret }, body: JSON.stringify(payload),
});
const calls = (name: string) => fetcher.mock.calls.filter(([url]) => String(url).endsWith(`/rpc/${name}`));
const args = (name: string) => JSON.parse(String(calls(name)[0]?.[1]?.body));
const paidStarts = () => fetcher.mock.calls.filter(([url, init]) => String(url).includes('/actors/') && init?.method === 'POST');

beforeEach(() => {
  values = { PROVIDER_MODE: 'apify', APIFY_REEL_ACTOR_RESOURCE_ID: 'actor', APIFY_API_TOKEN: 'synthetic-token', APIFY_ACCOUNT_ID: 'account',
    APIFY_WEBHOOK_SHARED_SECRET: 'webhook', SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
    INTERNAL_CRON_SECRET: 'internal', REELRADAR_OWNER_USER_ID: owner, SCRAPING_ENABLED: 'true', PROVIDER_VALIDATED: 'true',
    RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true', CAROUSEL_PROVIDER_VALIDATED: 'true', CAROUSEL_PILOT_JOB_ID: selected };
  context = { job: { id: selected, owner_user_id: owner, kind: 'carousel', collection_source: 'ordinary', live: true, status: 'processing', results_limit: 30,
    reserved_usd: .1, expected_actor_id: 'actor', expected_provider_user_id: 'account', dispatch_nonce: nonce, lease_token: lease,
    actor_run_id: 'accepted', dataset_id: 'dataset', dataset_cursor: 1, dataset_finished: true,
    started_at: '2026-11-14T10:00:00Z', result_fetched_at: '2026-11-14T10:01:00Z', actual_cost_usd: null,
    provider_terminal_status: 'SUCCEEDED' }, creators: [{ id: creator, username: 'fixture' }] };
  run = { id: 'accepted', actId: 'actor', userId: 'account', status: 'SUCCEEDED', defaultDatasetId: 'dataset', defaultKeyValueStoreId: 'store', usageTotalUsd: null };
  output = { ok: true, total_items: 0, users: [{ user: 'fixture', count: 0 }] };
  dataset = [{ ownerUsername: 'fixture', error: 'no_items' }]; claims = []; violations = [];
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] }, serve: vi.fn() });
  // No real transport is reachable: every endpoint is an inert, bounded fixture.
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://fixture.supabase.co') {
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBe('synthetic-service');
      expect(headers.get('authorization')).toBe('Bearer synthetic-service');
      if (url.pathname === '/rest/v1/scrape_jobs') return response(url.searchParams.has('id') ? [context.job] : []);
      const name = url.pathname.replace('/rest/v1/rpc/', '');
      if (name === 'worker_configure_carousel_automation') return response({ enabled: JSON.parse(String(init?.body)).p_enabled });
      if (name === 'worker_accounts') return response([{ owner_user_id: owner, account_slot: 1, provider_user_id: 'account', enabled: true, authorization_confirmed: true }]);
      if (name === 'worker_begin_account_usage') return response({ observation_id: nonce, observed_at: new Date().toISOString() });
      if (name === 'worker_claim_collection_executor') return response({ max_active: 3, max_starts_per_wake: 3,
        wake_revision: 1, drained_revision: 0, wake_pending: true, eligible_kinds: ['daily', 'carousel'], executor_nonce: lease,
        executor_revision: 1, executor_expires_at: new Date(Date.now() + 90000).toISOString(), executor_starts: 0,
        executor_start_limit: 3, wake_retry_after: null, claimed_revision: 1, starts_remaining: 3 });
      if (name === 'worker_release_collection_executor') return response(true);
      if (name === 'worker_claim_next') return response({ reason: 'no_pending_jobs' });
      if (name === 'worker_isolate_collection_settlement') { context.job.collection_source = 'operator_settle'; return response(null); }
      if (name === 'worker_drain_completion_wake') return response(true);
      if (name === 'worker_claim_reconciliation') return response(structuredClone(claims));
      if (name === 'worker_claim_processing') return response(structuredClone(context));
      if (name === 'worker_reconcile_run') return response({ ...context.job, status: 'running', provider_terminal_status: null });
      if (name === 'worker_claim_carousel_pilot') return response({ reason: 'pilot_job_not_pending' });
      if (name === 'worker_transcription_media_reconcile') return response({ status: 'not_linked' });
      if (name === 'worker_get_collection_recovery_state') return response({ input_digest: null, accepted_evidence: [], callback_hints: [] });
      if (name === 'worker_record_accepted_evidence') return response({ recorded: true });
      if (name === 'worker_claim_missing_run_recovery') return response([]);
      if (['worker_competitor_maintain', 'worker_carousel_maintain', 'worker_expire_dispatches', 'worker_record_usage', 'worker_record_callback_receipt',
        'worker_attach_run', 'worker_complete_reconciliation', 'worker_ingest_page', 'worker_record_output_summary', 'worker_finish_processing'].includes(name)) {
        return response(name === 'worker_record_callback_receipt' ? { accepted: true } : {});
      }
    }
    if (url.origin === 'https://api.apify.com' && init?.method !== 'POST') {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
      if (url.pathname === '/v2/users/me') return response({ data: { id: 'account' } });
      if (url.pathname === '/v2/users/me/limits') return response({ data: { monthlyUsageCycle: {
        startAt: new Date(Date.now() - 86400000).toISOString(), endAt: new Date(Date.now() + 86400000).toISOString(),
      }, current: { monthlyUsageUsd: 0 }, limits: { maxMonthlyUsageUsd: 5 } } });
      if (url.pathname === '/v2/actor-runs/accepted') return response({ data: run });
      if (url.pathname === '/v2/key-value-stores/store/records/OUTPUT') return response(output);
      if (url.pathname === '/v2/datasets/dataset/items') return response(dataset);
    }
    violations.push(`Unexpected fixture transport ${url.origin}${url.pathname}`);
    throw new Error('Unexpected fixture transport');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  try { expect(violations).toEqual([]); expect(paidStarts()).toHaveLength(0); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe('gated carousel automation maintenance', () => {
  it.each(['dispatch', 'reconcile'])('maintains one owner-bounded batch before generic %s dispatch and existing budget gates', async endpoint => {
    const handler = endpoint === 'dispatch' ? dispatcher.handler : reconciler.handler;
    expect((await handler(request({ continuation_budget: 0 }))).status).toBe(200);
    expect(calls('worker_carousel_maintain')).toHaveLength(1);
    expect(args('worker_carousel_maintain')).toEqual({ p_owner_user_id: owner, p_limit: 10 });
    const order = fetcher.mock.calls.map(([url]) => String(url));
    expect(order.findIndex(url => url.endsWith('/worker_competitor_maintain'))).toBeLessThan(order.findIndex(url => url.endsWith('/worker_carousel_maintain')));
    expect(order.findIndex(url => url.endsWith('/worker_claim_collection_executor'))).toBeLessThan(order.findIndex(url => url.endsWith('/worker_carousel_maintain')));
    expect(order.findIndex(url => url.endsWith('/worker_claim_collection_executor'))).toBeLessThan(order.findIndex(url => url.endsWith('/worker_begin_account_usage')));
    expect(order.findIndex(url => url.endsWith('/worker_record_usage'))).toBeLessThan(order.findIndex(url => url.endsWith('/worker_claim_next')));
    expect(calls('worker_claim_next')).toHaveLength(1); // Empty SQL queue, not client candidate reads.
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/scrape_jobs?'))).toBe(false);
    expect(calls('worker_install_competitor_schedules')).toHaveLength(0);
    expect(calls('worker_schedule')).toHaveLength(0);
  });
  it.each([undefined, 'false', 'TRUE', 'True', '1', ' true '])('never runs automation with a non-exact provider gate: %s', async gate => {
    if (gate === undefined) delete values.CAROUSEL_PROVIDER_VALIDATED; else values.CAROUSEL_PROVIDER_VALIDATED = gate;
    for (const handler of [dispatcher.handler, reconciler.handler]) expect((await handler(request({ continuation_budget: 0 }))).status).toBe(200);
    expect(calls('worker_carousel_maintain')).toHaveLength(0);
  });
  it.each(['dispatch', 'reconcile'])('fails closed if automation maintenance is unavailable during %s', async endpoint => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).endsWith('/worker_carousel_maintain')
      ? Promise.resolve(new Response('private failure detail', { status: 503 })) : original(url, init));
    const result = await (endpoint === 'dispatch' ? dispatcher.handler : reconciler.handler)(request({ continuation_budget: 0 }));
    expect(result.status).toBe(503);
    expect(JSON.stringify(await result.json())).not.toContain('private failure detail');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/scrape_jobs?'))).toBe(false);
    expect(calls('worker_claim_collection_executor')).toHaveLength(1); expect(calls('worker_claim_next')).toHaveLength(0);
    expect(calls('worker_release_collection_executor')).toHaveLength(1);
  });
  it.each([{ carousel_pilot_job_id: selected }, { settle_job_id: selected }])('never maintains automation in scoped reconciliation: %j', async scope => {
    expect((await reconciler.handler(request({ ...scope, continuation_budget: 0 }))).status).toBe(200);
    expect(calls('worker_carousel_maintain')).toHaveLength(0);
    expect(calls('worker_competitor_maintain')).toHaveLength(0);
    expect(calls('worker_expire_dispatches')).toHaveLength(0);
    expect(args('worker_claim_reconciliation')).toMatchObject({ p_owner_user_id: owner, p_job_id: selected, p_limit: 10 });
  });
  it('keeps the capped pilot action separate even after the general gate is validated', async () => {
    expect((await dispatcher.handler(request({ action: 'carousel_pilot', job_id: selected, continuation_budget: 0 }))).status).toBe(200);
    expect(calls('worker_claim_carousel_pilot')).toHaveLength(1);
    expect(calls('worker_carousel_maintain')).toHaveLength(0);
    expect(calls('worker_competitor_maintain')).toHaveLength(0);
  });
  it.each([true, false])('durably attaches a CREATED/READY callback without automation maintenance, pilot selected: %s', async pilot => {
    if (!pilot) delete values.CAROUSEL_PILOT_JOB_ID;
    context.job.status = 'uncertain'; context.job.actor_run_id = null; context.job.provider_terminal_status = null;
    run.status = 'READY';
    claims = [{ job: context.job, callback_hint: { run_id: 'accepted', dispatch_nonce: nonce }, reconciliation_token: lease }];
    const result = await webhook.handler(new Request(`https://fixture.test/apify-webhook?job_id=${selected}&dispatch_nonce=${nonce}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 'webhook' }, body: JSON.stringify({ run_id: 'accepted' }),
    }));
    expect(result.status).toBe(200);
    expect(calls('worker_record_callback_receipt')).toHaveLength(1);
    expect(args('worker_attach_run')).toMatchObject({ p_job_id: selected, p_dispatch_nonce: nonce, p_run_id: 'accepted' });
    expect(args('worker_complete_reconciliation')).toMatchObject({ p_callback_state: 'verified' });
    expect(calls('worker_carousel_maintain')).toHaveLength(0);
    expect(calls('worker_competitor_maintain')).toHaveLength(0);
  });
});

describe('internal-only carousel automation configuration', () => {
  it.each([true, false])('configures enabled=%s using only service RPC and environment-derived validation', async enabled => {
    const result = await dispatcher.handler(request({ action: 'configure_carousel_automation', enabled }));
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ automation: { enabled } });
    expect(args('worker_configure_carousel_automation')).toEqual({ p_owner_user_id: owner, p_enabled: enabled, p_provider_validated: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(calls('worker_carousel_maintain')).toHaveLength(0);
  });
  it('permits an owner-authorized disable with provider and paid-start gates closed', async () => {
    for (const name of ['CAROUSEL_PROVIDER_VALIDATED', 'SCRAPING_ENABLED', 'PROVIDER_VALIDATED', 'ACCOUNT_USAGE_VALIDATED', 'RUN_CHARGE_CAP_VALIDATED',
      'APIFY_API_TOKEN', 'APIFY_ACCOUNT_ID', 'APIFY_REEL_ACTOR_RESOURCE_ID', 'APIFY_WEBHOOK_SHARED_SECRET']) delete values[name];
    const result = await dispatcher.handler(request({ action: 'configure_carousel_automation', enabled: false }));
    expect(result.status).toBe(200);
    expect(args('worker_configure_carousel_automation')).toEqual({ p_owner_user_id: owner, p_enabled: false, p_provider_validated: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['CAROUSEL_PROVIDER_VALIDATED', 'SCRAPING_ENABLED', 'PROVIDER_VALIDATED', 'ACCOUNT_USAGE_VALIDATED', 'RUN_CHARGE_CAP_VALIDATED',
    'APIFY_API_TOKEN', 'APIFY_REEL_ACTOR_RESOURCE_ID', 'APIFY_WEBHOOK_SHARED_SECRET'])('rejects enable before database/provider transport without %s', async name => {
    delete values[name];
    expect((await dispatcher.handler(request({ action: 'configure_carousel_automation', enabled: true }))).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'true', 1, {}])('requires a boolean enabled flag: %j', async enabled => {
    expect((await dispatcher.handler(request({ action: 'configure_carousel_automation', enabled }))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ provider_validated: true }, { p_provider_validated: true }, { owner_user_id: creator }, { kind: 'daily' }])('rejects caller gate/scope overrides: %j', async extra => {
    expect((await dispatcher.handler(request({ action: 'configure_carousel_automation', enabled: true, ...extra }))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires internal header authentication, not webhook or bearer-only credentials', async () => {
    for (const value of [request({ action: 'configure_carousel_automation', enabled: false }, 'wrong'),
      request({ action: 'configure_carousel_automation', enabled: false }, 'webhook', 'x-webhook-secret'),
      request({ action: 'configure_carousel_automation', enabled: false }, 'Bearer synthetic-service', 'authorization')]) {
      expect((await dispatcher.handler(value)).status).toBe(401);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([undefined, creator.replaceAll('-', ''), 'not-a-uuid'])('requires a configured valid owner even for disable: %s', async id => {
    if (id === undefined) delete values.REELRADAR_OWNER_USER_ID; else values.REELRADAR_OWNER_USER_ID = id;
    expect((await dispatcher.handler(request({ action: 'configure_carousel_automation', enabled: false }))).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('carousel capped and verified-empty OUTPUT reconciliation', () => {
  it.each([1, 30])('keeps valid counts but never marks a charge-capped %s-item feed complete', count => {
    context.job.dataset_cursor = count;
    const summary = providers.reconcileOutput({ ok: true, total_items: count, charge_limit_reached: true, users: [{ user: 'fixture', count }] }, context);
    expect(summary).toEqual({ ok: true, total_items: count, users: [{ creator_id: creator, username: 'fixture', count, error: null }],
      complete: false, reason: 'output_incomplete_or_error' });
    expect(providers.reconcileOutput({ ok: true, total_items: count, charge_limit_reached: false, users: [{ user: 'fixture', count }] }, context).complete).toBe(true);
  });
  it('never treats an explicitly empty capped feed as complete', () => {
    expect(providers.reconcileOutput({ ...output, charge_limit_reached: true, users: [{ user: 'fixture', count: 0, error: 'no_items' }] }, context))
      .toMatchObject({ complete: false, total_items: 1, users: [{ count: 1, error: null }] });
  });
  it.each(['carousel', 'discovery'])('rescues the omitted empty error only from the exact finished owned %s dataset', async kind => {
    context.job.kind = kind;
    const summary = await new providers.ApifyCarousels().summary(context);
    expect(summary).toEqual({ ok: true, total_items: 1, users: [{ creator_id: creator, username: 'fixture', count: 1, error: null }], complete: true, reason: null });
    const read = fetcher.mock.calls.find(([url]) => String(url).includes('/datasets/'));
    expect(String(read?.[0])).toBe('https://api.apify.com/v2/datasets/dataset/items?format=json&clean=true&offset=0&limit=2');
    expect(JSON.stringify(summary)).not.toMatch(/private|unavailable|carousel_count/);
  });
  it.each([
    { label: 'unfinished', target: 'job', patch: { dataset_finished: false } },
    { label: 'wrong cursor', target: 'job', patch: { dataset_cursor: 2 } },
    { label: 'wrong run dataset', target: 'run', patch: { defaultDatasetId: 'foreign' } },
    { label: 'running run', target: 'run', patch: { status: 'RUNNING' } },
    { label: 'capped output', target: 'output', patch: { charge_limit_reached: true } },
    { label: 'nonempty total', target: 'output', patch: { total_items: 1 } },
    { label: 'nonempty user count', target: 'output', patch: { users: [{ user: 'fixture', count: 1 }] } },
    { label: 'provider privacy error', target: 'output', patch: { users: [{ user: 'fixture', count: 0, error: 'private' }] } },
  ])('does not rescue an ambiguous empty summary: $label', async ({ target, patch }) => {
    Object.assign(target === 'job' ? context.job : target === 'run' ? run : output, patch);
    expect((await new providers.ApifyCarousels().summary(context)).complete).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/datasets/'))).toBe(false);
  });
  it.each([[], [{ ownerUsername: 'fixture', error: 'private' }], [{ ownerUsername: 'fixture' }],
    [{ ownerUsername: 'fixture', error: 'no_items' }, { ownerUsername: 'fixture', error: 'no_items' }]].map(rows => ({ rows })))(
    'does not infer empty or private from missing/non-exact raw rows: $rows', async ({ rows }) => {
      dataset = rows;
      expect((await new providers.ApifyCarousels().summary(context)).complete).toBe(false);
    },
  );
  it.each(['output', 'dataset'])('rejects a foreign %s owner rather than rescuing the empty feed', async target => {
    if (target === 'output') output.users = [{ user: 'stranger', count: 0 }];
    else dataset = [{ ownerUsername: 'stranger', error: 'no_items' }];
    await expect(new providers.ApifyCarousels().summary(context)).rejects.toThrow('creator mismatch');
    if (target === 'output') expect(fetcher.mock.calls.some(([url]) => String(url).includes('/datasets/'))).toBe(false);
  });
  it.each(['id', 'actId', 'userId'])('rejects foreign run %s before reading its OUTPUT or dataset', async key => {
    run[key] = 'foreign';
    await expect(new providers.ApifyCarousels().summary(context)).rejects.toThrow('identity mismatch');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/records/OUTPUT') || String(url).includes('/datasets/'))).toBe(false);
  });
  it('preserves valid normalized records while persisting an incomplete capped summary', async () => {
    context.job.dataset_cursor = 0; context.job.dataset_finished = false;
    dataset = [{ ownerUsername: 'fixture', type: 8, productType: 'carousel_container', url: 'https://www.instagram.com/p/FIXTURE/',
      timestamp: '2026-11-13T12:00:00Z', likesCount: 5, commentsCount: 0, childPosts: [{ type: 1 }, { type: 1 }] }];
    output = { ok: true, total_items: 1, charge_limit_reached: true, users: [{ user: 'fixture', count: 1 }] };
    expect(await worker.processJob(selected)).toBe('finished');
    expect(args('worker_ingest_page')).toMatchObject({ p_job_id: selected, p_records: [{ creator_id: creator, content_type: 'carousel' }],
      p_errors: [], p_received_counts: { [creator]: 1 } });
    expect(args('worker_record_output_summary')).toMatchObject({ p_summary: { complete: false, reason: 'output_incomplete_or_error' } });
    expect(calls('worker_finish_processing')).toHaveLength(1);
  });
  it('processes an exact empty photo placeholder without fabricated records or privacy errors', async () => {
    context.job.dataset_cursor = 0; context.job.dataset_finished = false;
    expect(await worker.processJob(selected)).toBe('finished');
    expect(args('worker_ingest_page')).toMatchObject({ p_records: [], p_errors: [], p_received_counts: { [creator]: 1 } });
    expect(args('worker_record_output_summary')).toMatchObject({ p_summary: { complete: true, total_items: 1, users: [{ count: 1, error: null }] } });
  });
});
