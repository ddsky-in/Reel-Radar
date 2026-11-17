import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../src/app/api/[...path]/route';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import { createDemoData } from '../src/lib/demo';
import { safeCarouselSummaryPage, safeCollectionSummary, safeCreator, safeCreatorDirectory, safeCreatorPage, safeCreatorRead } from '../src/lib/server/public-data';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Carousel, CarouselSummary, Creator, CreatorCollectionSummary, CreatorDirectoryEntry, PageResult } from '../src/lib/types';

const origin = 'http://127.0.0.1:3100';
const fixture = createDemoData(), workspace = fixture.workspaces[0].id;
function get(resource: string, query = '', workspaceId = workspace) {
  const path = ['workspaces', workspaceId, ...resource.split('/')];
  return GET(new Request(`${origin}/api/${path.join('/')}${query ? '?' + query : ''}`), { params: Promise.resolve({ path }) });
}
beforeEach(() => {
  vi.stubGlobal('__reelradarDemo', undefined); vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DEMO_MODE', 'true'); vi.stubEnv('ALLOW_LOCAL_DEMO', 'true'); vi.stubEnv('SCRAPING_ENABLED', 'false'); vi.stubEnv('NEXT_PUBLIC_APP_URL', origin);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function seed() {
  const repo = new DemoRepository();
  await repo.settings({ capacity: 1000 });
  for (let index = 0; index < 124; index++) await repo.addCreator(workspace, `api_page_${String(index).padStart(3, '0')}`);
  return repo;
}
describe('paged research API contracts', () => {
  it('preserves legacy arrays while paged search returns full totals, stable boundaries, and singular off-page enrichment', async () => {
    await seed();
    const legacy = await (await get('creators')).json(); expect(Array.isArray(legacy)).toBe(true);
    const firstResponse = await get('competitors', 'search=API_PAGE&page=1&limit=50');
    expect(firstResponse.status).toBe(200); expect(firstResponse.headers.get('cache-control')).toBe('no-store, private');
    const first: PageResult<Creator> = await firstResponse.json();
    const second: PageResult<Creator> = await (await get('competitors', 'search=api_page&page=2&limit=50')).json();
    const third: PageResult<Creator> = await (await get('competitors', 'search=api_page&page=3&limit=50')).json();
    expect([first.items.length, second.items.length, third.items.length]).toEqual([50, 50, 24]);
    expect([first.total, second.total, third.total]).toEqual([124, 124, 124]);
    expect([...first.items, ...second.items, ...third.items].map(row => row.username)).toEqual(Array.from({ length: 124 }, (_, index) => `api_page_${String(index).padStart(3, '0')}`));
    expect(first.items[0]).toMatchObject({ tracked_reels: 0, tracked_carousels: 0, latest_reel_date: null, initial_backfill_job_id: null, initial_backfill_status: null });
    expect(await (await get(`creators/${third.items[23].id}`)).json()).toEqual(third.items[23]);
    expect(await (await get('competitors', 'search=api_page&page=10000&limit=50')).json()).toEqual({ items: [], total: 124, page: 10000, limit: 50 });
    expect(await (await get('competitors', 'search=nothing-matches')).json()).toEqual({ items: [], total: 0, page: 1, limit: 50 });
  });

  it('counts raw synthetic carousel posts across paged, singular and legacy creator reads, independently of gallery pagination or filters', async () => {
    const data: Omit<ReturnType<typeof createDemoData>, 'carousels'> & { carousels: Carousel[] } = createDemoData();
    const creator = data.creators[0], post = data.carousels[0];
    data.carousels = Array.from({ length: 63 }, (_, index) => ({ ...post, id: `ca100000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      shortcode: `SYNTHETIC_COUNT_${index}`, creator_id: creator.id, username: creator.username, published_at: index === 62 ? null : post.published_at }));
    vi.stubGlobal('__reelradarDemo', { data, saved: [] });
    const repo = new DemoRepository();
    const gallery = await repo.carousels(workspace, { creator: creator.id, limit: 1 });
    expect(gallery.items).toHaveLength(1); expect(gallery.total).toBe(63);
    expect((await repo.carousels(workspace, { creator: creator.id, saved: true })).total).toBe(0);
    const paged: PageResult<Creator> = await (await get('competitors', `search=${creator.username}&limit=1`)).json();
    const singular: Creator = await (await get(`creators/${creator.id}`)).json();
    const legacy: Creator[] = await (await get('creators')).json();
    for (const row of [paged.items[0], singular, legacy.find(row => row.id === creator.id)!]) {
      expect(row.tracked_carousels).toBe(63);
      expect(row.tracked_reels).toBe(data.reels.filter(reel => reel.creator_id === creator.id).length);
    }
    expect(legacy.filter(row => row.id !== creator.id).every(row => row.tracked_carousels === 0)).toBe(true);
    expect((await repo.addCreator(workspace, 'synthetic_count_zero')).tracked_carousels).toBe(0);
  });

  it('uses literal search without SQL wildcard semantics and excludes inactive associations from every new read', async () => {
    const repo = new DemoRepository();
    const one = await repo.addCreator(workspace, 'needle_one'), two = await repo.addCreator(workspace, 'needlexone');
    const result: PageResult<Creator> = await (await get('competitors', 'search=needle_')).json();
    expect(result.items.map(row => row.id)).toEqual([one.id]);
    expect((await (await get('competitors', 'search=%25')).json()).total).toBe(0);
    await repo.removeCreator(workspace, two.id);
    expect((await (await get('competitors', 'search=needle')).json()).total).toBe(1);
    const entries: CreatorDirectoryEntry[] = await (await get('creator-directory')).json();
    expect(entries.some(row => row.id === two.id)).toBe(false);
    expect(entries.find(row => row.id === one.id)).toEqual({ id: one.id, username: one.username, display_name: null, avatar_url: null, status: 'pending' });
    expect((await get(`creators/${two.id}`)).status).toBe(404);
  });

  it('returns lean active directories and count-only collection summaries even in archived readable workspaces', async () => {
    const repo = new DemoRepository(); await repo.updateWorkspace(workspace, { archived: true });
    const entries: CreatorDirectoryEntry[] = await (await get('creator-directory')).json();
    expect(entries.length).toBeGreaterThan(0);
    expect(Object.keys(entries[0]).sort()).toEqual(['avatar_url', 'display_name', 'id', 'status', 'username']);
    expect((await get(`creators/${entries[0].id}`)).status).toBe(200);
    const summary: CreatorCollectionSummary = await (await get('collection-summary')).json();
    expect(summary).toEqual({ reason: 'scraping_disabled', blocking_job_id: null, pending_jobs: 0, active_jobs: 0 });
    expect(await repo.collectionState(workspace)).toHaveProperty('pending_job_ids');
    const empty = await repo.createWorkspace('Empty API fixture');
    expect(await (await get('creator-directory', '', empty.id)).json()).toEqual([]);
    expect(await (await get('competitors', '', empty.id)).json()).toEqual({ items: [], total: 0, page: 1, limit: 50 });
  });

  it('rejects invalid, unknown, repeated and over-limit queries and unknown/foreign IDs', async () => {
    for (const query of ['page=0', 'page=10001', 'page=1.5', 'limit=51', 'limit=0', 'limit=-1', 'limit=', 'page=1&page=2', 'search=a&search=b', 'owner=foreign', 'search=' + 'a'.repeat(201), 'limit=Infinity', 'page=1e2']) {
      const response = await get('competitors', query); expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
    }
    for (const resource of ['creator-directory', 'collection-summary', `creators/${fixture.creators[0].id}`]) expect((await get(resource, 'unexpected=1')).status).toBe(400);
    expect((await get('carousel-summaries', 'limit=51')).status).toBe(400);
    expect((await get('carousel-summaries', 'page=1&page=2')).status).toBe(400);
    const unknown = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    for (const resource of ['competitors', 'creator-directory', 'collection-summary', 'carousel-summaries', `creators/${unknown}`]) expect((await get(resource, '', unknown)).status).toBe(404);
    expect((await get('creators/not-an-id')).status).toBe(400);
    const unavailable = fixture.creators.find(row => row.username === 'future.tools.demo')!;
    expect((await get(`creators/${unavailable.id}`, '', fixture.workspaces[1].id)).status).toBe(404);
  });

  it('fails closed without production owner/Supabase configuration for every new route', async () => {
    vi.stubEnv('DEMO_MODE', 'false');
    for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'OWNER_EMAIL', 'OWNER_USER_ID']) vi.stubEnv(key, '');
    for (const resource of ['competitors', 'creator-directory', 'collection-summary', 'carousel-summaries', `creators/${fixture.creators[0].id}`]) {
      const response = await get(resource); expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'CONFIG_REQUIRED' } });
    }
  });

  it('projects accurate slide counts, capped captions, covers, and metrics without changing full carousel details', async () => {
    const repo = new DemoRepository();
    const full = await repo.carousels(workspace, { limit: 50 });
    const response = await get('carousel-summaries', 'limit=50'); expect(response.status).toBe(200);
    const lean: PageResult<CarouselSummary> = await response.json();
    expect(lean.total).toBe(full.total);
    expect(lean.items.map(row => row.id)).toEqual(full.items.map(row => row.id));
    lean.items.forEach((row, index) => {
      expect(row.slide_count).toBe(full.items[index].slides.length);
      expect(row.caption_preview).toBe(full.items[index].caption.slice(0, 500));
      expect(row).not.toHaveProperty('caption'); expect(row).not.toHaveProperty('slides');
      expect(row.profile_outlier_score).toBe(full.items[index].profile_outlier_score);
    });
    expect((await repo.carouselDetail(workspace, full.items[0].id)).carousel.slides).toEqual(full.items[0].slides);
  });
});

describe('strict public DTO runtime validation', () => {
  it('preserves optional validated carousel counts without inventing zero for old servers or leaking non-allowlisted fields', async () => {
    const repo = new DemoRepository(), result = await repo.queryCreators(workspace, { limit: 1 }), value = result.items[0];
    const old = { ...value }; delete old.tracked_carousels;
    expect(safeCreatorRead(old)).not.toHaveProperty('tracked_carousels');
    expect(safeCreator(old)).not.toHaveProperty('tracked_carousels');
    expect(safeCreatorPage({ ...result, items: [old] }).items[0]).not.toHaveProperty('tracked_carousels');
    for (const count of [0, 63, Number.MAX_SAFE_INTEGER]) {
      const row = { ...value, tracked_carousels: count, provider_token: 'secret' };
      expect(safeCreatorRead(row)).toHaveProperty('tracked_carousels', count);
      expect(safeCreator(row)).toHaveProperty('tracked_carousels', count);
      expect(safeCreatorPage({ ...result, items: [row] }).items[0]).toHaveProperty('tracked_carousels', count);
      expect(safeCreator(row)).not.toHaveProperty('provider_token');
    }
    for (const count of [undefined, null, -1, 1.5, '5', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const row = { ...value, tracked_carousels: count };
      expect(() => safeCreatorRead(row), String(count)).toThrow('Research data could not be loaded.');
      expect(() => safeCreator(row as Creator), String(count)).toThrow('Research data could not be loaded.');
      expect(() => safeCreatorPage({ ...result, items: [row] }), String(count)).toThrow('Research data could not be loaded.');
    }
  });

  it('allowlists fields and rejects invalid enums, counts, dates, metadata, and missing creator values', async () => {
    const repo = new DemoRepository(), result = await repo.queryCreators(workspace, { limit: 1 }), value = result.items[0];
    expect(safeCreatorRead({ ...value, profile_job_status: 'running', expected_provider_user_id: 'secret', dataset_id: 'private' })).toMatchObject({ profile_job_status: 'running' });
    expect(JSON.stringify(safeCreatorPage({ ...result, items: [{ ...value, secret: 'private' }], secret: 'private' }))).not.toContain('private');
    for (const patch of [{ profile_job_status: 'made_up' }, { tracked_reels: -1 }, { tracked_reels: '5' }, { latest_reel_date: 'invalid' }, { status: 'made_up' }, { initial_backfill_status: 'fake' }, { id: 'invalid' }, { followers_count: Infinity }]) expect(() => safeCreatorRead({ ...value, ...patch })).toThrow();
    expect(() => safeCreatorRead({ id: value.id })).toThrow();
    for (const patch of [{ total: -1 }, { total: '2' }, { page: 0 }, { limit: 51 }, { items: [] }]) expect(() => safeCreatorPage({ ...result, ...patch })).toThrow();
    const entry = (await repo.creatorDirectory(workspace))[0];
    expect(safeCreatorDirectory([{ ...entry, secret: 'private' }])).toEqual([entry]);
    expect(() => safeCreatorDirectory([{ ...entry, status: undefined }])).toThrow();
    expect(() => safeCreatorDirectory(null)).toThrow();
    const summary = { reason: null, blocking_job_id: null, pending_jobs: 123, active_jobs: 4 };
    expect(safeCollectionSummary({ ...summary, profiles: [{ secret: 'private' }], pending_job_ids: ['private'], account_info: { token: 'private' } })).toEqual(summary);
    for (const patch of [{ pending_jobs: -1 }, { active_jobs: 1.5 }, { active_jobs: '2' }, { reason: 'fake' }, { blocking_job_id: 'private' }]) expect(() => safeCollectionSummary({ ...summary, ...patch })).toThrow();
    const posts = await repo.carouselSummaries(workspace, { limit: 1 });
    for (const patch of [{ slide_count: 21 }, { slide_count: -1 }, { slide_count: '2' }, { caption_preview: 'a'.repeat(501) }, { profile_baseline_sample: 31 }, { latest_fetched_at: null }, { likes_state: 'made_up' }]) expect(() => safeCarouselSummaryPage({ ...posts, items: [{ ...posts.items[0], ...patch }] })).toThrow();
    const safe = safeCarouselSummaryPage({ ...posts, items: [{ ...posts.items[0], caption: 'secret full caption', slides: [{ video_url: 'secret' }], token: 'private' }] });
    expect(JSON.stringify(safe)).not.toContain('secret'); expect(JSON.stringify(safe)).not.toContain('private');
  });

  it('rechecks workspace authorization and binds validated arguments to the dedicated Supabase RPCs, not legacy full reads', async () => {
    const sampleRepo = new DemoRepository();
    const page = await sampleRepo.queryCreators(workspace, { limit: 1 }), entry = (await sampleRepo.creatorDirectory(workspace))[0];
    const carousels = await sampleRepo.carouselSummaries(workspace, { limit: 1 });
    page.items[0].tracked_carousels = 63;
    const rpc = vi.fn(async (name: string) => ({ error: null, data: ({ query_creators: page, list_creator_directory: [entry], get_creator: page.items[0],
      get_creator_collection_summary: { reason: null, blocking_job_id: null, pending_jobs: 99, active_jobs: 3 }, query_carousel_summaries: carousels } as Record<string, unknown>)[name] }));
    const repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, 'owner', 'owner@example.invalid');
    const authorize = vi.spyOn(repo, 'workspace').mockResolvedValue({ ...fixture.workspaces[0], archived_at: new Date().toISOString() });
    expect((await repo.queryCreators(workspace, { search: '  Literal_%  ', page: 3, limit: 50 })).items[0]).toHaveProperty('tracked_carousels', 63);
    expect(rpc).toHaveBeenLastCalledWith('query_creators', { p_workspace_id: workspace, p_query: { search: 'Literal_%', page: 3, limit: 50 } });
    await repo.creatorDirectory(workspace); expect(rpc).toHaveBeenLastCalledWith('list_creator_directory', { p_workspace_id: workspace });
    expect(await repo.creator(workspace, page.items[0].id)).toHaveProperty('tracked_carousels', 63);
    expect(rpc).toHaveBeenLastCalledWith('get_creator', { p_workspace_id: workspace, p_creator_id: page.items[0].id });
    await repo.collectionSummary(workspace); expect(rpc).toHaveBeenLastCalledWith('get_creator_collection_summary', { p_workspace_id: workspace });
    await repo.carouselSummaries(workspace, { limit: 1 }); expect(rpc).toHaveBeenLastCalledWith('query_carousel_summaries', { p_workspace_id: workspace, p_query: { limit: 1 } });
    expect(authorize).toHaveBeenCalledTimes(5);
    await expect(repo.queryCreators(workspace, { limit: 51 })).rejects.toThrow();
    authorize.mockRejectedValue(new Error('forbidden')); rpc.mockClear();
    await expect(repo.creatorDirectory(workspace)).rejects.toThrow('forbidden');
    await expect(repo.queryCreators(workspace, {})).rejects.toThrow('forbidden');
    await expect(repo.creator(workspace, page.items[0].id)).rejects.toThrow('forbidden');
    await expect(repo.collectionSummary(workspace)).rejects.toThrow('forbidden');
    await expect(repo.carouselSummaries(workspace, {})).rejects.toThrow('forbidden');
    expect(rpc).not.toHaveBeenCalled();
  });
});
