import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const providers = await import('../supabase/functions/_shared/providers.ts' as string);
const worker = await import('../supabase/functions/_shared/worker.ts' as string);
const owner = '11111111-1111-4111-8111-111111111111';
const creator = '22222222-2222-4222-8222-222222222222';
const context = {
  job: { id: owner, kind: 'discovery', competitor_run_id: owner, discovery_bounded: true, results_limit: 50, collection_since: '2026-01-01T00:00:00Z',
    dataset_cursor: 0, dataset_finished: false, lease_token: owner, live: true, dataset_id: 'dataset', actor_run_id: 'run',
    expected_actor_id: 'actor', expected_provider_user_id: 'account' }, creators: [{ id: creator, username: 'fixture_creator' }],
};
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  const values: Record<string, string> = { PROVIDER_MODE: 'apify', APIFY_REEL_ACTOR_RESOURCE_ID: 'actor', APIFY_API_TOKEN: 'fixture', APIFY_ACCOUNT_ID: 'account',
    SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', INTERNAL_CRON_SECRET: 'fixture-secret',
    REELRADAR_OWNER_USER_ID: owner };
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] }, serve: vi.fn() });
  fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Transport forbidden outside the fixture'));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('competitor provider coverage contract', () => {
  it('requests at most 50 recent discovery Reels with UTC cutoff and pinned handling', () => {
    const adapter = new providers.ApifyReels();
    expect(adapter.input(context)).toEqual({
      directUrls: ['fixture_creator'], resultsType: 'reels', resultsLimit: 50, skipPinnedPosts: false,
      onlyPostsNewerThan: '2026-01-01T00:00:00.000Z', selectedFields: [],
    });
    expect(adapter.input({ ...context, job: { ...context.job, collection_since: null } })).not.toHaveProperty('onlyPostsNewerThan');
    for (const patch of [{ competitor_run_id: null }, { results_limit: 10001 }, { collection_since: 'invalid' }]) {
      expect(() => adapter.input({ ...context, job: { ...context.job, ...patch } })).toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('marks an otherwise verified fifty-row discovery window capped, not fully exhausted', () => {
    const ctx = { ...context, job: { ...context.job, dataset_cursor: 50, dataset_finished: true } };
    const output = { ok: true, total_items: 50, users: [{ user: 'fixture_creator', count: 50 }] };
    expect(providers.reconcileOutput(output, ctx)).toMatchObject({ complete: false, reason: 'discovery_window_capped' });
    expect(providers.reconcileOutput({ ...output, charge_limit_reached: true }, ctx)).toMatchObject({ complete: false, reason: 'output_incomplete_or_error' });
    expect(providers.reconcileOutput({ ok: true, total_items: 49, users: [{ user: 'fixture_creator', count: 49 }] },
      { ...ctx, job: { ...ctx.job, dataset_cursor: 49 } })).toMatchObject({ complete: true, reason: null });
    expect(providers.reconcileOutput({ ok: true, total_items: 51, users: [{ user: 'fixture_creator', count: 51 }] },
      { ...ctx, job: { ...ctx.job, dataset_cursor: 51 } }).complete).toBe(false);
    expect(() => new providers.ApifyReels().input({ ...context, job: { ...context.job, results_limit: 10000, discovery_bounded: false } })).toThrow('Bounded 50-Reel');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([1, 50, 122, 200, 9950, 10000])('requests tracked count + 50 for metrics without changing the Actor: %i', tracked => {
    const adapter = new providers.ApifyReels();
    const ctx = { ...context, job: { ...context.job, kind: 'metrics', metrics_tracked_count: tracked, results_limit: Math.min(tracked + 50, 10000) } };
    expect(adapter.input(ctx)).toEqual({ directUrls: ['fixture_creator'], resultsType: 'reels',
      resultsLimit: Math.min(tracked + 50, 10000), skipPinnedPosts: false, onlyPostsNewerThan: '2026-01-01T00:00:00.000Z', selectedFields: [] });
    expect(adapter.input({ ...ctx, job: { ...ctx.job, collection_since: null } })).not.toHaveProperty('onlyPostsNewerThan');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 0, -1, 1.5, NaN, '122'])('rejects unverified tracked-count metrics input: %s', tracked => {
    const adapter = new providers.ApifyReels();
    expect(() => adapter.input({ ...context, job: { ...context.job, kind: 'metrics', metrics_tracked_count: tracked, results_limit: 172 } })).toThrow('Frozen tracked Reels + 50');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects stale or expanded metrics limits before any provider request', () => {
    const adapter = new providers.ApifyReels();
    for (const results_limit of [122, 132, 173, 10000]) expect(() => adapter.input({ ...context,
      job: { ...context.job, kind: 'metrics', metrics_tracked_count: 122, results_limit } })).toThrow('Frozen tracked Reels + 50');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends one mocked paid-start request with the bounded metrics limit, never the 10,000 default', async () => {
    const values: Record<string, string> = { PROVIDER_MODE: 'apify', SCRAPING_ENABLED: 'true', PROVIDER_VALIDATED: 'true',
      RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true', APIFY_REEL_ACTOR_RESOURCE_ID: 'actor',
      APIFY_API_TOKEN: 'fixture', APIFY_ACCOUNT_ID: 'account', SUPABASE_URL: 'https://fixture.supabase.co', APIFY_WEBHOOK_SHARED_SECRET: 'fixture-webhook' };
    vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] } });
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/users/me')) return response({ data: { id: 'account' } });
      if (String(url).includes('/actors/actor/runs?') && init?.method === 'POST') return response({ data: {
        id: 'run', actId: 'actor', userId: 'account', status: 'RUNNING', defaultDatasetId: 'dataset' } });
      throw new Error('Unexpected fixture transport');
    });
    const ctx = { ...context, job: { ...context.job, kind: 'metrics', metrics_tracked_count: 122, results_limit: 172, reserved_usd: .01, dispatch_nonce: owner } };
    const adapter = new providers.ApifyReels();
    expect(await adapter.start(ctx, .01, async () => true)).toMatchObject({ id: 'run', actorId: 'actor' });
    const starts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(starts).toHaveLength(1);
    expect(JSON.parse(String(starts[0][1]?.body))).toMatchObject({ directUrls: ['fixture_creator'], resultsType: 'reels', resultsLimit: 172 });
    expect(new URL(String(starts[0][0])).searchParams.get('maxTotalChargeUsd')).toBe('0.01');
    fetcher.mockClear();
    await expect(new providers.ApifyReels().start({ ...ctx, job: { ...ctx.job, metrics_tracked_count: null, results_limit: 10000 } }, .01)).rejects.toThrow('Frozen tracked Reels + 50');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('accepts verified bounded feed output at the limit; SQL still requires every frozen target', () => {
    const ctx = { ...context, job: { ...context.job, kind: 'metrics', metrics_tracked_count: 122, results_limit: 172, dataset_cursor: 172 } };
    const output = { ok: true, total_items: 172, users: [{ user: 'fixture_creator', count: 172 }] };
    expect(providers.reconcileOutput(output, ctx).complete).toBe(true);
    expect(providers.reconcileOutput({ ...output, charge_limit_reached: true }, ctx).complete).toBe(false);
    expect(providers.reconcileOutput(output, { ...ctx, job: { ...ctx.job, metrics_tracked_count: null } }).complete).toBe(false);
    expect(providers.reconcileOutput({ ...output, total_items: 173, users: [{ user: 'fixture_creator', count: 173 }] },
      { ...ctx, job: { ...ctx.job, dataset_cursor: 173 } }).complete).toBe(false);
  });
  it.each([
    { cursor: 0, total: 0, count: 0 }, { cursor: 1, total: 0, count: 0 },
    { cursor: 1, total: 1, count: 0 }, { cursor: 1, total: 1, count: 1 },
  ])('accepts verified empty discovery without confusing raw rows and imported Reels: %j', ({ cursor, total, count }) => {
    const result = providers.reconcileOutput({ ok: true, total_items: total, users: [{ user: 'fixture_creator', count, error: 'no_items' }] },
      { ...context, job: { ...context.job, dataset_cursor: cursor } });
    expect(result).toMatchObject({ complete: true, total_items: cursor, users: [{ creator_id: creator, count: cursor, error: null }] });
  });
  it('refuses truncated histories, provider limits, and inconsistent owner/count metadata', () => {
    const ctx = { ...context, job: { ...context.job, kind: 'metrics', dataset_cursor: 10000 } };
    expect(providers.reconcileOutput({ ok: true, total_items: 10000, users: [{ user: 'fixture_creator', count: 10000 }] }, ctx).complete).toBe(false);
    for (const output of [
      { ok: true, total_items: 0, charge_limit_reached: true, users: [{ user: 'fixture_creator', count: 0 }] },
      { ok: true, total_items: 0, users: [{ user: 'foreign_creator', count: 0 }] },
      { ok: true, total_items: 0, users: [{ user: 'fixture_creator', count: 2 }] },
    ]) expect(providers.reconcileOutput(output, context).complete).toBe(false);
  });
  it('counts a no_items placeholder as delivered, imports nothing and still records the provider summary', async () => {
    fetcher.mockImplementation(async (url) => {
      const address = String(url);
      if (address.endsWith('/users/me')) return response({ data: { id: 'account' } });
      if (address.endsWith('/worker_claim_processing')) return response(structuredClone(context));
      if (address.includes('/datasets/dataset/items')) return response([{ ownerUsername: 'fixture_creator', error: 'no_items' }]);
      if (address.includes('/actor-runs/run')) return response({ data: { id: 'run', actId: 'actor', userId: 'account', status: 'SUCCEEDED', defaultKeyValueStoreId: 'store' } });
      if (address.includes('/records/OUTPUT')) return response({ ok: true, total_items: 1, users: [{ user: 'fixture_creator', count: 0, error: 'no_items' }] });
      if (address.endsWith('/worker_ingest_page') || address.endsWith('/worker_record_output_summary') || address.endsWith('/worker_finish_processing')) return response({});
      throw new Error('Unexpected fixture transport');
    });
    expect(await worker.processJob(owner)).toBe('finished');
    const call = (name: string) => JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).endsWith(`/${name}`))![1]?.body));
    expect(call('worker_ingest_page')).toMatchObject({ p_records: [], p_errors: [], p_received_counts: { [creator]: 1 }, p_next_cursor: 1, p_finished: true });
    expect(call('worker_record_output_summary').p_summary.complete).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/actors/'))).toBe(false);
  });
  it('verifies the owned dataset placeholder when OUTPUT omits its no_items error', async () => {
    fetcher.mockImplementation(async (url) => {
      const address = String(url);
      if (address.endsWith('/users/me')) return response({ data: { id: 'account' } });
      if (address.endsWith('/worker_claim_processing')) return response(structuredClone(context));
      if (address.includes('/datasets/dataset/items')) return response([{ ownerUsername: 'fixture_creator', error: 'no_items' }]);
      if (address.includes('/actor-runs/run')) return response({ data: { id: 'run', actId: 'actor', userId: 'account', status: 'SUCCEEDED', defaultDatasetId: 'dataset', defaultKeyValueStoreId: 'store', usageTotalUsd: .00005 } });
      if (address.includes('/records/OUTPUT')) return response({ ok: true, total_items: 0, users: [{ user: 'fixture_creator', count: 0 }] });
      if (address.endsWith('/worker_ingest_page') || address.endsWith('/worker_record_output_summary') || address.endsWith('/worker_finish_processing')) return response({});
      throw new Error('Unexpected fixture transport');
    });
    expect(await worker.processJob(owner)).toBe('finished');
    const call = (name: string) => JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).endsWith(`/${name}`))![1]?.body));
    expect(call('worker_ingest_page')).toMatchObject({ p_records: [], p_errors: [], p_received_counts: { [creator]: 1 } });
    expect(call('worker_record_output_summary').p_summary).toMatchObject({ complete: true, total_items: 1, users: [{ count: 1, error: null }] });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/datasets/'))).toHaveLength(2);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/actors/'))).toBe(false);
  });
  it.each([
    { item: { ownerUsername: 'foreign_creator', error: 'no_items' } },
    { item: { ownerUsername: 'fixture_creator', error: 'private' } },
    { item: { ownerUsername: 'fixture_creator', id: 'a-real-reel' } },
    { dataset: 'different-dataset' }, { status: 'FAILED' }, { charge_limit_reached: true },
    { extraRow: true }, { kind: 'metrics' }, { finished: false },
  ])('does not treat unverified or incomplete datasets as empty discovery: %j', async patch => {
    fetcher.mockImplementation(async (url) => {
      const address = String(url);
      if (address.endsWith('/users/me')) return response({ data: { id: 'account' } });
      if (address.includes('/actor-runs/run')) return response({ data: { id: 'run', actId: 'actor', userId: 'account', status: patch.status ?? 'SUCCEEDED', defaultDatasetId: patch.dataset ?? 'dataset', defaultKeyValueStoreId: 'store' } });
      if (address.includes('/records/OUTPUT')) return response({ ok: true, total_items: 0, charge_limit_reached: patch.charge_limit_reached, users: [{ user: 'fixture_creator', count: 0 }] });
      if (address.includes('/datasets/dataset/items')) return response([patch.item ?? { ownerUsername: 'fixture_creator', error: 'no_items' }, ...(patch.extraRow ? [{}] : [])]);
      throw new Error('Unexpected fixture transport');
    });
    const result = await new providers.ApifyReels().summary({ ...context, job: { ...context.job, kind: patch.kind ?? 'discovery', dataset_cursor: 1, dataset_finished: patch.finished ?? true } }).catch(() => ({ complete: false }));
    expect(result.complete).toBe(false);
  });
  it.each([true, false])('counts a metrics collaboration only with explicit requested-creator coauthorship: %s', async coauthor => {
    fetcher.mockImplementation(async (url) => {
      const address = String(url);
      if (address.endsWith('/users/me')) return response({ data: { id: 'account' } });
      if (address.endsWith('/worker_claim_processing')) return response({ ...structuredClone(context), job: { ...context.job, kind: 'metrics' } });
      if (address.includes('/datasets/dataset/items')) return response([{ ownerUsername: 'other_owner', url: 'https://www.instagram.com/reel/shared_reel/',
        coauthorProducers: [{ username: coauthor ? 'fixture_creator' : 'someone_else' }] }]);
      if (address.includes('/actor-runs/run')) return response({ data: { id: 'run', actId: 'actor', userId: 'account', status: 'SUCCEEDED', defaultKeyValueStoreId: 'store' } });
      if (address.includes('/records/OUTPUT')) return response({ ok: true, total_items: 1, users: [{ user: 'fixture_creator', count: 1 }] });
      if (address.endsWith('/worker_ingest_page') || address.endsWith('/worker_record_output_summary') || address.endsWith('/worker_finish_processing')) return response({});
      throw new Error('Unexpected fixture transport');
    });
    expect(await worker.processJob(owner)).toBe('finished');
    const ingest = JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).endsWith('/worker_ingest_page'))![1]?.body));
    expect(ingest.p_records).toEqual([]);
    expect(ingest.p_received_counts).toEqual(coauthor ? { [creator]: 1 } : {});
    expect(ingest.p_errors).toHaveLength(coauthor ? 0 : 1);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/actors/'))).toBe(false);
  });
});

describe('authenticated background collection endpoints', () => {
  it.each(['refresh-dispatch', 'reconcile-jobs'])('%s rejects unauthorized requests before database/provider work', async name => {
    const { handler } = await import(`../supabase/functions/${name}/index.ts`);
    expect((await handler(new Request('https://fixture.test', { method: 'POST', body: '{}' }))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns 202 while retaining dispatched work with waitUntil', async () => {
    const pending: Promise<unknown>[] = [];
    vi.stubGlobal('EdgeRuntime', { waitUntil: (work: Promise<unknown>) => pending.push(work) });
    fetcher.mockResolvedValue(response({ job_ids: [] }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handler } = await import('../supabase/functions/refresh-dispatch/index.ts' as string);
    const result = await handler(new Request('https://fixture.test', { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': 'fixture-secret' }, body: '{}' }));
    expect(result.status).toBe(202); expect(await result.json()).toEqual({ accepted: true });
    expect(pending).toHaveLength(1); await Promise.all(pending);
    // Invalid provider setup now fails before maintenance can touch the DB.
    expect(fetcher).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[ReelRadar] Collection dispatch failed; durable maintenance will retry.');
  });
});
