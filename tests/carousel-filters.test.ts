import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoData } from '../src/lib/demo';
import { carouselActiveFilterCount, carouselFilterSchema, carouselPeriod, carouselQueryString, readCarouselQuery } from '../src/lib/carousels';
import { carouselFollowerOutlier, withCarouselMetrics } from '../src/lib/metrics';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { safeCarouselFilter } from '../src/lib/server/carousel-data';
import type { Carousel, CarouselQuery } from '../src/lib/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
  const data: Omit<ReturnType<typeof createDemoData>, 'carousels'> & { carousels: Carousel[] } = createDemoData();
  const seed = data.carousels[0], other = data.carousels.find(post => post.creator_id !== seed.creator_id)!;
  const posts = [
    { ...seed, id: data.carousels[0].id, caption: 'Strong hook 100%', latest_likes: 10, latest_comments: 0, followers_count: 100, published_at: '2026-11-12T00:00:00Z' },
    { ...seed, id: data.carousels[1].id, caption: 'Zero interactions', latest_likes: 0, latest_comments: 0, followers_count: 100, published_at: '2026-11-04T18:30:00Z' },
    { ...seed, id: data.carousels[2].id, caption: 'Hidden likes', likes_state: 'hidden' as const, latest_likes: null, latest_comments: 0, followers_count: 100, published_at: '2026-11-11T00:00:00Z' },
    { ...other, id: data.carousels[3].id, caption: 'Another strong hook', latest_likes: 50, latest_comments: 0, followers_count: 100, published_at: '2026-11-04T18:29:59Z' },
    { ...seed, id: data.carousels[4].id, caption: 'No captured followers', latest_likes: 10, latest_comments: 0, followers_count: null, published_at: null },
    { ...seed, id: data.carousels[5].id, caption: 'Future post', latest_likes: 10, latest_comments: 0, followers_count: 100, published_at: '2026-11-12T18:30:00Z' },
  ];
  data.carousels = withCarouselMetrics(posts);
  vi.stubGlobal('__reelradarDemo', { data, saved: [] });
  return { data, seed, other, repo: new DemoRepository(), workspace: data.workspaces[0].id };
}

describe('carousel filter contract', () => {
  it('round-trips multiple channels, decimal ranges and rolling periods without UI defaults', () => {
    const ids = createDemoData().creators.slice(0, 2).map(creator => creator.id);
    const query: CarouselQuery = { creator_ids: ids, min_outlier: 0.1, max_outlier: 1, min_profile_outlier: 5, max_profile_outlier: 10, min_engagement: 0, max_engagement: 100, posted_amount: 2, posted_unit: 'weeks', keywords: 'a & b', page: 2 };
    expect(readCarouselQuery(new URLSearchParams(carouselQueryString(query)))).toEqual(query);
    expect(readCarouselQuery(new URLSearchParams())).toEqual({});
    expect(readCarouselQuery(new URLSearchParams('creator_ids=%5B%5D'))).toEqual({ creator_ids: [] });
    expect(carouselActiveFilterCount(query)).toBe(6);
  });

  it('rejects reversed ranges, malformed channels and unsupported Reel filters', () => {
    const id = createDemoData().creators[0].id;
    const invalid = ['min_outlier=2&max_outlier=1', 'max_outlier=101', 'min_engagement=-1', 'max_engagement=101', 'max_profile_outlier=1000001', 'min_outlier=1e2', 'posted_amount=7', 'posted_amount=13&posted_unit=months', 'posted_amount=53&posted_unit=weeks', 'posted_amount=0&posted_unit=days', 'posted_amount=1.5&posted_unit=days', 'creator_ids=null', 'creator_ids=%7B%7D', 'creator_ids=%5B%22invalid%22%5D', `creator_ids=${encodeURIComponent(JSON.stringify([id, id]))}`, `creator=${id}&creator_ids=%5B%5D`, 'min_views=0', 'freshness=stale', 'from=2026-01-01', 'keywords=a&keywords=b'];
    for (const value of invalid) expect(() => readCarouselQuery(new URLSearchParams(value)), value).toThrow();
  });

  it('uses the same IST rolling calendar and month-end behavior as Reels', () => {
    expect(carouselPeriod({ posted_amount: 7, posted_unit: 'days' }, new Date('2026-11-12T20:00:00Z'))).toEqual({ from: '2026-11-06', to: '2026-11-13' });
    expect(carouselPeriod({ posted_amount: 1, posted_unit: 'months' }, new Date('2026-03-31T06:00:00Z'))).toEqual({ from: '2026-02-28', to: '2026-03-31' });
    expect(carouselPeriod({})).toBeNull();
  });

  it('filters known zeroes while excluding hidden counts and missing follower bases', async () => {
    const { repo, workspace } = fixture();
    const zero = await repo.carousels(workspace, { min_engagement: 0, max_engagement: 0 });
    expect(zero.items.map(post => post.caption)).toEqual(['Zero interactions']);
    const exact = await repo.carousels(workspace, { min_outlier: 0.1, max_outlier: 0.1, keywords: '100%' });
    expect(exact.items.map(post => post.caption)).toEqual(['Strong hook 100%']);
    expect((await repo.carousels(workspace, { min_profile_outlier: 0 })).total).toBe(0);
    expect(carouselFollowerOutlier(10, 0, 100)).toBe(0.1);
    expect(carouselFollowerOutlier(null, 0, 100)).toBeNull();
    expect(carouselFollowerOutlier(10, 0, 0)).toBeNull();
  });

  it('keeps channel selection restricted and includes only publication dates within the IST window', async () => {
    const { repo, workspace, seed, other } = fixture();
    expect((await repo.carousels(workspace, { creator_ids: [] })).total).toBe(0);
    expect((await repo.carousels(workspace, { creator_ids: [other.creator_id] })).items.map(post => post.caption)).toEqual(['Another strong hook']);
    const page = await repo.carousels(workspace, { creator_ids: [seed.creator_id, other.creator_id], posted_amount: 7, posted_unit: 'days' });
    expect(page.items.map(post => post.caption)).toEqual(['Strong hook 100%', 'Hidden likes', 'Zero interactions']);
    expect((await repo.carousels(workspace, { creator_ids: ['ffffffff-ffff-4fff-8fff-ffffffffffff'] })).total).toBe(0);
  });

  it('saves a rolling combination separately from Reels and validates loaded preset data', async () => {
    const { repo, seed } = fixture();
    const query: CarouselQuery = { creator_ids: [seed.creator_id], posted_amount: 7, posted_unit: 'days', min_profile_outlier: 5 };
    const saved = await repo.createCarouselFilter('  Strong hooks  ', query);
    expect(safeCarouselFilter({ ...saved, owner_user_id: 'private' })).toEqual(saved);
    expect(saved).toMatchObject({ name: 'Strong hooks', config: { version: 1, query } });
    expect(await repo.reelFilters()).toEqual([]);
    await expect(repo.createCarouselFilter('strong HOOKS', {})).rejects.toThrow('already exists');
    expect(() => carouselFilterSchema.parse({ name: 'Invalid', query: { page: 2 } })).toThrow();
    expect(() => safeCarouselFilter({ ...saved, config: { version: 1, query: { min_views: 100 } } })).toThrow('could not be loaded');
    await repo.deleteCarouselFilter(saved.id);
    expect(await repo.carouselFilters()).toEqual([]);
  });
});
