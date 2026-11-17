import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const providers = await import('../supabase/functions/_shared/providers.ts' as string);
const worker = await import('../supabase/functions/_shared/worker.ts' as string);
const owner = 'ce500000-0000-4000-8000-000000000001';
const jobId = 'ce500000-0000-4000-8000-000000000002';
const creator = 'ce500000-0000-4000-8000-000000000003';
const initialRequest = 'ce500000-0000-4000-8000-000000000004';
const foreign = 'ce500000-0000-4000-8000-000000000005';
let values: Record<string, string>;
let context: { job: Record<string, unknown>; creators: { id: string; username: string }[] };
let dataset: unknown[];
let output: Record<string, unknown>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const response = (value: unknown) => Response.json(value);
const run = { id: 'accepted', actId: 'actor', userId: 'account', status: 'SUCCEEDED', defaultDatasetId: 'dataset', defaultKeyValueStoreId: 'store' };
const photo = (index: number, single = false) => ({ ownerUsername: 'fixture', type: single ? 1 : 8,
  productType: single ? 'feed' : 'carousel_container', url: `https://www.instagram.com/p/SYNTHETIC_${index}/`,
  timestamp: '2026-11-13T12:00:00Z', caption: 'Synthetic worker fixture, not verified Instagram data',
  likesCount: 5, commentsCount: -1, childPosts: [{ media_type: 1 }, { media_type: 2 }] });
const calls = (name: string) => fetcher.mock.calls.filter(([url]) => String(url).endsWith(`/rpc/${name}`));
const args = (name: string) => JSON.parse(String(calls(name)[0]?.[1]?.body));
const datasetReads = () => fetcher.mock.calls.filter(([url]) => String(url).includes('/datasets/'));

beforeEach(() => {
  values = { PROVIDER_MODE: 'apify', APIFY_REEL_ACTOR_RESOURCE_ID: 'actor', APIFY_API_TOKEN: 'synthetic-token', APIFY_ACCOUNT_ID: 'account',
    APIFY_WEBHOOK_SHARED_SECRET: 'synthetic-webhook', SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
    SCRAPING_ENABLED: 'true', PROVIDER_VALIDATED: 'true', RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true', CAROUSEL_PROVIDER_VALIDATED: 'true' };
  context = { job: { id: jobId, owner_user_id: owner, kind: 'carousel', collection_source: 'ordinary', status: 'processing', live: true,
    results_limit: 50, carousel_initial: true, carousel_automatic: true, carousel_initial_request_id: initialRequest,
    requested_profiles_count: 1, manual_authorized_by: owner, carousel_automation_scheduled_at: '2026-11-14T10:00:00Z', reserved_usd: .1,
    expected_actor_id: 'actor', expected_provider_user_id: 'account', dispatch_nonce: owner, lease_token: foreign,
    actor_run_id: 'accepted', dataset_id: 'dataset', dataset_cursor: 0, dataset_finished: false,
    started_at: '2026-11-14T10:00:00Z', result_fetched_at: '2026-11-14T10:01:00Z', actual_cost_usd: null, provider_terminal_status: 'SUCCEEDED' },
    creators: [{ id: creator, username: 'fixture' }] };
  dataset = [photo(1)]; output = { ok: true, total_items: 1, users: [{ user: 'fixture', count: 1 }] };
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] } });
  // All provider/database transport is inert synthetic fixture data; no network fallback.
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://fixture.supabase.co') {
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBe('synthetic-service');
      expect(headers.get('authorization')).toBe('Bearer synthetic-service');
      const name = url.pathname.replace('/rest/v1/rpc/', '');
      if (name === 'worker_claim_processing') return response(structuredClone(context));
      if (['worker_ingest_page', 'worker_record_output_summary', 'worker_finish_processing', 'worker_release_processing'].includes(name)) return response(null);
    }
    if (url.origin === 'https://api.apify.com') {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
      if (url.pathname === '/v2/users/me') return response({ data: { id: 'account' } });
      if (url.pathname === '/v2/actors/actor/runs' && init?.method === 'POST') return response({ data: run });
      if (url.pathname === '/v2/actor-runs/accepted') return response({ data: run });
      if (url.pathname === '/v2/key-value-stores/store/records/OUTPUT') return response(output);
      if (url.pathname === '/v2/datasets/dataset/items') {
        const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
        return response(dataset.slice(offset, offset + limit));
      }
    }
    throw new Error('Unexpected fixture transport');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('durable initial carousel provider window', () => {
  it('uses exactly50 photo posts and skips pinned only for a marked authorized initial job', () => {
    expect(new providers.ApifyCarousels().input(context)).toEqual({ directUrls: ['fixture'], resultsType: 'photos', resultsLimit: 50, skipPinnedPosts: true, selectedFields: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([false, true])('preserves the30-photo ordinary/manual/daily input with automatic=%s', automatic => {
    Object.assign(context.job, { results_limit: 30, carousel_initial: false, carousel_automatic: automatic, carousel_initial_request_id: null });
    expect(new providers.ApifyCarousels().input(context)).toEqual({ directUrls: ['fixture'], resultsType: 'photos', resultsLimit: 30, skipPinnedPosts: false, selectedFields: [] });
    delete context.job.carousel_initial;
    expect(new providers.ApifyCarousels().input(context).resultsLimit).toBe(30);
  });
  it.each([
    { carousel_initial: undefined }, { carousel_initial: false }, { carousel_initial: 'true' }, { carousel_initial: 1 },
    { carousel_automatic: undefined }, { carousel_automatic: false }, { carousel_automatic: 'true' },
    { results_limit: 30 }, { results_limit: 49 }, { results_limit: 51 }, { results_limit: '50' },
    { kind: 'daily' }, { kind: 'manual' }, { kind: 'profile' },
    { id: null }, { id: 'invalid' }, { owner_user_id: null }, { owner_user_id: 'invalid' },
    { manual_authorized_by: null }, { manual_authorized_by: 'invalid' }, { manual_authorized_by: foreign },
    { carousel_initial_request_id: undefined }, { carousel_initial_request_id: null }, { carousel_initial_request_id: 'invalid' },
    { requested_profiles_count: undefined }, { requested_profiles_count: 0 }, { requested_profiles_count: 2 }, { requested_profiles_count: '1' },
    { collection_source: undefined }, { collection_source: 'legacy' }, { collection_source: 'target_media' }, { collection_source: 'carousel_pilot' },
  ])('rejects unmarked/invalid/mismatched initial metadata before provider transport: %j', patch => {
    Object.assign(context.job, patch);
    expect(() => new providers.ApifyCarousels().input(context)).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([[], [{ id: 'invalid', username: 'fixture' }], [{ id: creator, username: 'INVALID' }], [{ id: creator, username: 'bad/name' }],
    [{ id: creator, username: 'fixture' }, { id: foreign, username: 'second' }]].map(creators => ({ creators })))(
    'requires one valid typed creator identity: $creators', ({ creators }) => {
    context.creators = creators;
    expect(() => new providers.ApifyCarousels().input(context)).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('can settle a durably marked initial job without changing its input window', () => {
    context.job.collection_source = 'operator_settle';
    expect(new providers.ApifyCarousels().input(context).resultsLimit).toBe(50);
  });
  it.each(['false', 'TRUE', '1', ' true '])('does not use the pilot exception to bypass the general gate for initial50: %s', gate => {
    values.CAROUSEL_PROVIDER_VALIDATED = gate;
    expect(() => new providers.ApifyCarousels().input(context)).toThrow('mapping');
    values.CAROUSEL_PILOT_JOB_ID = jobId;
    expect(() => new providers.ApifyCarousels().input(context)).toThrow('window');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['true', 'false'])('keeps a selected pilot strictly30 even with general validation=%s', gate => {
    values.CAROUSEL_PROVIDER_VALIDATED = gate; values.CAROUSEL_PILOT_JOB_ID = jobId.toUpperCase();
    const adapter = new providers.ApifyCarousels();
    expect(() => adapter.input(context)).toThrow('window');
    Object.assign(context.job, { results_limit: 30, carousel_initial: false, carousel_automatic: false, carousel_initial_request_id: null, collection_source: 'carousel_pilot' });
    expect(adapter.input(context)).toEqual({ directUrls: ['fixture'], resultsType: 'photos', resultsLimit: 30, skipPinnedPosts: false, selectedFields: [] });
  });
  it('rejects durable pilot50 even after removing the temporary pilot env', () => {
    context.job.collection_source = 'carousel_pilot';
    expect(() => new providers.ApifyCarousels().input(context)).toThrow('window');
  });
  it.each(['SCRAPING_ENABLED', 'PROVIDER_VALIDATED', 'RUN_CHARGE_CAP_VALIDATED', 'ACCOUNT_USAGE_VALIDATED', 'CAROUSEL_PROVIDER_VALIDATED'])('requires the existing live gate %s for a50-photo start', async name => {
    values[name] = 'false';
    await expect(new providers.ApifyCarousels().start(context, .1)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends only the bounded initial Actor input on an inert start fixture', async () => {
    const accepted = await new providers.ApifyCarousels().start(context, .1, async () => true);
    const starts = fetcher.mock.calls.filter(([url, init]) => String(url).includes('/actors/') && init?.method === 'POST');
    expect(starts).toHaveLength(1);
    expect(JSON.parse(String(starts[0][1]?.body))).toEqual({ directUrls: ['fixture'], resultsType: 'photos', resultsLimit: 50, skipPinnedPosts: true, selectedFields: [] });
    expect(accepted.usageTotalUsd).toBeNull(); // No inferred billing from50 source rows.
  });
  it('rejects an unmarked50 start before any account/provider transport', async () => {
    delete context.job.carousel_initial;
    await expect(new providers.ApifyCarousels().start(context, .1)).rejects.toThrow('window');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('initial carousel raw dataset bounds', () => {
  it('bounds the100-row worker read to50 and finishes without asking for more history', async () => {
    dataset = Array.from({ length: 51 }, (_, index) => photo(index));
    const adapter = new providers.ApifyCarousels();
    const page = await adapter.page(context, 100);
    expect(page).toMatchObject({ next: 50, finished: true }); expect(page.items).toHaveLength(50);
    expect(new URL(String(datasetReads()[0][0])).searchParams.get('limit')).toBe('50');
    context.job.dataset_cursor = 50;
    expect(await adapter.page(context, 100)).toEqual({ items: [], next: 50, finished: true });
    expect(datasetReads()).toHaveLength(1);
  });
  it('bounds resumed reads to the remaining raw window', async () => {
    dataset = Array.from({ length: 50 }, (_, index) => photo(index)); context.job.dataset_cursor = 47;
    const page = await new providers.ApifyCarousels().page(context, 100);
    expect(page).toEqual({ items: dataset.slice(47), next: 50, finished: true });
    const url = new URL(String(datasetReads()[0][0]));
    expect(url.searchParams.get('offset')).toBe('47'); expect(url.searchParams.get('limit')).toBe('3');
  });
  it('supports smaller ingestion pages but never goes past50', async () => {
    dataset = Array.from({ length: 50 }, (_, index) => photo(index));
    const adapter = new providers.ApifyCarousels();
    expect(await adapter.page(context, 20)).toMatchObject({ next: 20, finished: false });
    context.job.dataset_cursor = 20;
    expect(await adapter.page(context, 20)).toMatchObject({ next: 40, finished: false });
    context.job.dataset_cursor = 40;
    expect(await adapter.page(context, 20)).toMatchObject({ next: 50, finished: true });
    expect(datasetReads().map(([url]) => new URL(String(url)).searchParams.get('limit'))).toEqual(['20', '20', '10']);
  });
  it.each([-1, 50.5, 51, Number.MAX_SAFE_INTEGER + 1, '0', null])('rejects invalid or over-window durable cursor before transport: %j', async cursor => {
    context.job.dataset_cursor = cursor;
    await expect(new providers.ApifyCarousels().page(context, 100)).rejects.toThrow('cursor');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, Infinity])('rejects an invalid page limit before transport: %s', async limit => {
    await expect(new providers.ApifyCarousels().page(context, limit)).rejects.toThrow('limit');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([0, 49])('rejects over-returned rows rather than truncating or advancing from%s', async cursor => {
    context.job.dataset_cursor = cursor;
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).includes('/datasets/') ? Promise.resolve(response(Array.from({ length: 51 - cursor }, (_, i) => photo(i)))) : original(url, init));
    await expect(new providers.ApifyCarousels().page(context, 100)).rejects.toThrow('Invalid dataset page');
    expect(context.job.dataset_cursor).toBe(cursor);
  });
  it('leaves ordinary30 provider reads unchanged', async () => {
    Object.assign(context.job, { results_limit: 30, carousel_initial: false });
    expect(await new providers.ApifyCarousels().page(context, 100)).toEqual({ items: dataset, next: 1, finished: true });
    expect(new URL(String(datasetReads()[0][0])).searchParams.get('limit')).toBe('100');
  });
  it('rejects an already-finished initial job with a raw cursor beyond50 before OUTPUT transport', async () => {
    context.job.dataset_cursor = 51; context.job.dataset_finished = true;
    await expect(new providers.ApifyCarousels().summary(context)).rejects.toThrow('cursor');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('initial carousel worker reconciliation uses raw photo counts', () => {
  it.each([3, 50])('imports fewer valid carousels than the%s delivered photo rows without widening the window', async count => {
    dataset = Array.from({ length: count }, (_, index) => photo(index, index % 2 === 1));
    output = { ok: true, total_items: count, users: [{ user: 'fixture', count }] };
    expect(await worker.processJob(jobId)).toBe('finished');
    expect(calls('worker_ingest_page')).toHaveLength(1);
    const ingested = args('worker_ingest_page');
    expect(ingested).toMatchObject({ p_expected_cursor: 0, p_next_cursor: count, p_finished: true, p_errors: [], p_received_counts: { [creator]: count } });
    expect(ingested.p_records).toHaveLength(Math.ceil(count / 2));
    expect(ingested.p_records.map((record: { shortcode: string }) => record.shortcode)).toEqual(Array.from({ length: Math.ceil(count / 2) }, (_, i) => `SYNTHETIC_${i * 2}`));
    expect(args('worker_record_output_summary').p_summary).toEqual({ ok: true, total_items: count, users: [{ creator_id: creator, username: 'fixture', count, error: null }], complete: true, reason: null });
    // OUTPUT counts delivered photo rows, not accepted carousels or source exhaustion.
    expect(calls('worker_finish_processing')).toHaveLength(1); expect(datasetReads()).toHaveLength(1);
  });
  it.each([
    { charge_limit_reached: true }, { total_items: 51 }, { users: [{ user: 'fixture', count: 51 }] },
    { users: [{ user: 'stranger', count: 50 }] }, { users: [{ user: 'fixture', count: 50, error: 'private' }] },
  ])('preserves accepted records but cannot verify mismatched/capped/error OUTPUT: %j', async patch => {
    dataset = Array.from({ length: 50 }, (_, i) => photo(i));
    output = { ok: true, total_items: 50, users: [{ user: 'fixture', count: 50 }], ...patch };
    expect(await worker.processJob(jobId)).toBe('finished');
    expect(args('worker_ingest_page').p_records).toHaveLength(50);
    expect(args('worker_record_output_summary').p_summary.complete).toBe(false);
  });
  it('counts an empty placeholder without fabricated carousel records', async () => {
    dataset = [{ ownerUsername: 'fixture', error: 'no_items' }];
    output = { ok: true, total_items: 0, users: [{ user: 'fixture', count: 0, error: 'no_items' }] };
    expect(await worker.processJob(jobId)).toBe('finished');
    expect(args('worker_ingest_page')).toMatchObject({ p_records: [], p_errors: [], p_received_counts: { [creator]: 1 }, p_next_cursor: 1 });
    expect(args('worker_record_output_summary').p_summary).toMatchObject({ complete: true, total_items: 1 });
  });
  it('releases processing without ingesting or advancing when the provider overruns50', async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).includes('/datasets/') ? Promise.resolve(response(Array.from({ length: 51 }, (_, i) => photo(i)))) : original(url, init));
    expect(await worker.processJob(jobId)).toBe('processing_retry_required');
    expect(calls('worker_ingest_page')).toHaveLength(0); expect(calls('worker_finish_processing')).toHaveLength(0);
    expect(args('worker_release_processing')).toMatchObject({ p_job_id: jobId, p_error: 'Bounded processing failed; cursor preserved for reconciliation' });
  });
});
