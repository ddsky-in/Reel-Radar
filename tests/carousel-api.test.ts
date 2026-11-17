import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, POST, PUT } from '../src/app/api/[...path]/route';
import { createDemoData } from '../src/lib/demo';
import type { CarouselDetail, PageResult, Carousel, SavedCarouselFilter } from '../src/lib/types';

const origin = 'http://127.0.0.1:3100';
const fixture = createDemoData();
const workspaceId = fixture.workspaces[0].id;
const carouselId = fixture.carousels[0].id;

function save(workspace: string, carousel: string, body: unknown, requestOrigin: string | null = origin) {
  const path = ['workspaces', workspace, 'carousels', carousel, 'saved'];
  return PUT(new Request(`${origin}/api/${path.join('/')}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(requestOrigin === null ? {} : { origin: requestOrigin }) },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ path }) });
}

async function detail(workspace = workspaceId, carousel = carouselId): Promise<CarouselDetail> {
  const path = ['workspaces', workspace, 'carousels', carousel];
  const response = await GET(new Request(`${origin}/api/${path.join('/')}`), { params: Promise.resolve({ path }) });
  expect(response.status).toBe(200);
  return response.json();
}

async function savedCarousels(): Promise<PageResult<Carousel>> {
  const path = ['workspaces', workspaceId, 'carousels'];
  const response = await GET(new Request(`${origin}/api/${path.join('/')}?saved=true`), { params: Promise.resolve({ path }) });
  expect(response.status).toBe(200);
  return response.json();
}
async function presetRequest(method: 'GET' | 'POST' | 'DELETE', body?: unknown, id?: string, requestOrigin = origin) {
  const path = ['carousel-filters', ...(id ? [id] : [])];
  const request = new Request(`${origin}/api/${path.join('/')}`, { method, headers: { 'content-type': 'application/json', origin: requestOrigin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return ({ GET, POST, DELETE }[method])(request, { params: Promise.resolve({ path }) });
}

beforeEach(() => {
  vi.stubGlobal('__reelradarDemo', undefined);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('ALLOW_LOCAL_DEMO', 'true');
  vi.stubEnv('SCRAPING_ENABLED', 'false');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', origin);
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('carousel save API', () => {
  it('persists notes and deduplicated tags through PUT, then removes the saved post', async () => {
    const response = await save(workspaceId, carouselId, { saved: true, note: 'Strong opening hook', tags: ['hook', 'tutorial', 'hook'] });
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect((await detail()).carousel).toMatchObject({ saved: true, note: 'Strong opening hook', tags: ['hook', 'tutorial'] });
    expect((await savedCarousels()).items.some(carousel => carousel.id === carouselId)).toBe(true);
    expect((await detail(fixture.workspaces[2].id)).carousel).toMatchObject({ saved: false, note: '', tags: [] });

    expect((await save(workspaceId, carouselId, { saved: false })).status).toBe(204);
    expect((await detail()).carousel.saved).toBe(false);
    expect((await savedCarousels()).items.some(carousel => carousel.id === carouselId)).toBe(false);
  });

  it('rejects missing or foreign origins without saving research', async () => {
    for (const requestOrigin of [null, 'https://foreign.example']) {
      const response = await save(workspaceId, carouselId, { saved: true }, requestOrigin);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_ORIGIN' } });
    }
    expect((await detail()).carousel.saved).toBe(false);
  });

  it('rejects posts outside the workspace creator membership', async () => {
    const unavailable = fixture.carousels.find(carousel => carousel.username === 'future.tools.demo')!;
    const response = await save(fixture.workspaces[1].id, unavailable.id, { saved: true });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect((await detail(workspaceId, unavailable.id)).carousel.saved).toBe(false);
  });

  it('rejects unknown bookmark fields before writing', async () => {
    const response = await save(workspaceId, carouselId, { saved: true, views: 123 });
    expect(response.status).toBe(400);
    expect((await detail()).carousel.saved).toBe(false);
  });

  it('fails closed in production without Supabase and owner configuration', async () => {
    vi.stubEnv('DEMO_MODE', 'false');
    for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'OWNER_EMAIL', 'OWNER_USER_ID']) vi.stubEnv(name, '');
    const response = await save(workspaceId, carouselId, { saved: true });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'CONFIG_REQUIRED' } });
  });
  it('creates, lists and deletes a reusable rolling carousel filter through the real API route', async () => {
    const query = { creator_ids: [fixture.creators[0].id], min_outlier: 0.1, max_profile_outlier: 20, posted_amount: 7, posted_unit: 'days' };
    const created = await presetRequest('POST', { name: '  Strong hooks  ', query });
    expect(created.status).toBe(201);
    const preset: SavedCarouselFilter = await created.json();
    expect(preset).toMatchObject({ name: 'Strong hooks', config: { version: 1, query } });
    expect(preset).not.toHaveProperty('owner_user_id');
    expect(await (await presetRequest('GET')).json()).toEqual([preset]);
    expect((await presetRequest('POST', { name: 'strong HOOKS', query })).status).toBe(409);
    expect((await presetRequest('DELETE', undefined, preset.id)).status).toBe(204);
    expect(await (await presetRequest('GET')).json()).toEqual([]);
  });
  it('rejects foreign origins and malformed carousel presets without writing', async () => {
    expect((await presetRequest('POST', { name: 'Foreign', query: {} }, undefined, 'https://foreign.example')).status).toBe(403);
    for (const query of [{ page: 2 }, { min_views: 1 }, { posted_amount: 7 }, { min_outlier: 2, max_outlier: 1 }]) expect((await presetRequest('POST', { name: 'Invalid', query })).status).toBe(400);
    expect(await (await presetRequest('GET')).json()).toEqual([]);
    const path = ['carousel-filters'];
    const invalidGet = await GET(new Request(`${origin}/api/carousel-filters?owner=other`), { params: Promise.resolve({ path }) });
    expect(invalidGet.status).toBe(400);
    vi.stubEnv('DEMO_MODE', 'false');
    for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'OWNER_EMAIL', 'OWNER_USER_ID']) vi.stubEnv(name, '');
    expect((await presetRequest('GET')).status).toBe(503);
    expect((await presetRequest('POST', { name: 'Denied', query: {} })).status).toBe(503);
  });
});
