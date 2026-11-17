import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDemoData } from '../src/lib/demo';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';

const fixture = createDemoData(), workspace = fixture.workspaces[0].id;
beforeEach(() => vi.stubGlobal('__reelradarDemo', undefined));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup(code = 'PGRST202') {
  const demo = new DemoRepository();
  const creators = (await demo.queryCreators(workspace, { limit: 50 })).items, collection = await demo.collectionState(workspace), carousels = await demo.carousels(workspace, { limit: 30 });
  const rpc = vi.fn(async (name: string) => {
    const legacy = { list_creators: creators, get_creator_collection_state: collection, query_carousels: carousels } as Record<string, unknown>;
    return name in legacy ? { data: legacy[name], error: null } : { data: null, error: { code, message: 'Private upstream details' } };
  });
  const repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, 'owner', 'owner@example.invalid');
  const authorize = vi.spyOn(repo, 'workspace').mockResolvedValue(fixture.workspaces[0]);
  return { repo, rpc, authorize, creators, carousels };
}

describe('rolling authorized research read compatibility', () => {
  it('uses the existing creator read only for an absent new RPC, preserving literal search, paging and totals', async () => {
    const { repo, rpc, creators } = await setup();
    const search = creators[0].username.toUpperCase();
    const first = await repo.queryCreators(workspace, { search, page: 1, limit: 1 });
    expect(first).toMatchObject({ total: 1, page: 1, limit: 1 });
    expect(first.items[0].id).toBe(creators[0].id);
    expect(await repo.queryCreators(workspace, { search, page: 2, limit: 1 })).toEqual({ items: [], total: 1, page: 2, limit: 1 });
    expect(await repo.queryCreators(workspace, { search: '%', page: 1, limit: 50 })).toEqual({ items: [], total: 0, page: 1, limit: 50 });
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['query_creators', 'list_creators', 'query_creators', 'list_creators', 'query_creators', 'list_creators']);
    expect(JSON.stringify(first)).not.toContain('Private upstream details');
  });
  it('preserves unavailable old-server carousel counts and forwards validated new counts without per-creator or gallery RPCs', async () => {
    const { repo, rpc, creators } = await setup();
    creators.forEach(creator => { delete creator.tracked_carousels; });
    expect((await repo.queryCreators(workspace, { limit: 1 })).items[0]).not.toHaveProperty('tracked_carousels');
    expect(await repo.creator(workspace, creators[0].id)).not.toHaveProperty('tracked_carousels');
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['query_creators', 'list_creators', 'get_creator', 'list_creators']);
    creators[0].tracked_carousels = 63; rpc.mockClear();
    expect((await repo.queryCreators(workspace, { search: creators[0].username, limit: 1 })).items[0]).toHaveProperty('tracked_carousels', 63);
    expect(await repo.creator(workspace, creators[0].id)).toHaveProperty('tracked_carousels', 63);
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['query_creators', 'list_creators', 'get_creator', 'list_creators']);
    creators[0].tracked_carousels = -1;
    await expect(repo.queryCreators(workspace, { search: creators[0].username, limit: 1 })).rejects.toThrow('Research data could not be loaded');
    await expect(repo.creator(workspace, creators[0].id)).rejects.toThrow('Research data could not be loaded');
  });

  it('projects directory, singular creator, summary and carousel DTOs from independently authorized legacy reads', async () => {
    const { repo, authorize, creators, carousels } = await setup();
    const directory = await repo.creatorDirectory(workspace);
    expect(directory).toHaveLength(creators.length);
    expect(Object.keys(directory[0]).sort()).toEqual(['avatar_url', 'display_name', 'id', 'status', 'username']);
    expect((await repo.creator(workspace, creators[0].id)).id).toBe(creators[0].id);
    await expect(repo.creator(workspace, 'ffffffff-ffff-4fff-8fff-ffffffffffff')).rejects.toThrow('not found');
    expect(await repo.collectionSummary(workspace)).toEqual({ reason: 'scraping_disabled', blocking_job_id: null, pending_jobs: 0, active_jobs: 0 });
    const lean = await repo.carouselSummaries(workspace, { limit: 30 });
    expect(lean.total).toBe(carousels.total);
    expect(lean.items).toHaveLength(carousels.items.length);
    expect(lean.items[0]).toMatchObject({ slide_count: carousels.items[0].slides.length, caption_preview: carousels.items[0].caption.slice(0, 500) });
    expect(lean.items[0]).not.toHaveProperty('slides');
    expect(lean.items[0]).not.toHaveProperty('caption');
    expect(authorize).toHaveBeenCalledTimes(10);
  });
  it.each(['42501', 'PGRST301', '08006', 'P0002'])('never falls back after authorization or service failure %s', async code => {
    const { repo, rpc } = await setup(code);
    await expect(repo.queryCreators(workspace, {})).rejects.toThrow();
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['query_creators']);
  });
  it('never falls back before successful workspace authorization or from a malformed successful DTO', async () => {
    const { repo, rpc, authorize } = await setup();
    authorize.mockRejectedValue(new Error('forbidden'));
    await expect(repo.creatorDirectory(workspace)).rejects.toThrow('forbidden');
    expect(rpc).not.toHaveBeenCalled();
    authorize.mockResolvedValue(fixture.workspaces[0]);
    rpc.mockResolvedValue({ data: { items: [], total: 1, page: 1, limit: 50 }, error: null });
    await expect(repo.queryCreators(workspace, {})).rejects.toThrow('Research data could not be loaded');
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['query_creators']);
  });
});
