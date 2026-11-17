import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourceCache, clearResourceCache, getResourceSnapshot, subscribeResource } from '../src/lib/resource-cache';
import { mutationResourceDependencies, resourceMatchesFamilies, savedReelResourceMatches } from '../src/lib/resource-dependencies';
import { api } from '../src/lib/client';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const caches: ReturnType<typeof createResourceCache>[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  caches.splice(0).forEach(cache => cache.clear()); clearResourceCache();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
const paths = [
  '/api/workspaces/a/reels?saved=true', '/api/workspaces/a/reels/id',
  '/api/workspaces/a/reels/id/neighbors?saved=true', '/api/workspaces/a/overview',
  '/api/workspaces/a/creators', '/api/workspaces/a/collection-status',
  '/api/workspaces/b/reels', '/api/workspaces/a/carousels',
  '/api/reel-filters', '/api/carousel-filters', '/api/jobs', '/api/bootstrap',
];
async function setup() {
  const load = vi.fn(async (path: string) => ({ path }));
  const cache = createResourceCache({ load }); caches.push(cache);
  paths.forEach(path => cache.subscribe(path, () => {})); await flush(); load.mockClear();
  return { cache, load, reads: () => load.mock.calls.map(call => call[0]) };
}

describe('scoped cache dependency predicates', () => {
  it('matches bookmarks only to Reel/overview/navigation in this workspace', () => {
    const expected = paths.slice(0, 4);
    expect(paths.filter(path => resourceMatchesFamilies(path, ['saved_reels'], 'a'))).toEqual(expected);
    expect(paths.filter(path => savedReelResourceMatches(path, 'a'))).toEqual(expected);
    expect(savedReelResourceMatches('/api/workspaces/ab/reels', 'a')).toBe(false);
    expect(savedReelResourceMatches('/api/workspaces/a/reels/id/transcript', 'a')).toBe(false);
    expect(resourceMatchesFamilies('/api/workspaces/a/reels/id/transcript', ['saved_reels'], 'a')).toBe(false);
  });
  it('keeps presets independent and unknown endpoints safe', () => {
    expect(paths.filter(path => resourceMatchesFamilies(path, ['reel_filters']))).toEqual(['/api/reel-filters']);
    expect(paths.filter(path => resourceMatchesFamilies(path, ['carousel_filters']))).toEqual(['/api/carousel-filters']);
    expect(resourceMatchesFamilies('/api/new-endpoint', ['reels'], 'a')).toBe(true);
    expect(resourceMatchesFamilies('/api/workspaces/a/new-endpoint', ['reels'], 'b')).toBe(true);
    expect(savedReelResourceMatches('/api/new-endpoint', 'a')).toBe(false);
  });
  it('keeps canonical changes owner-global and job progress separate from plain lists', () => {
    expect(resourceMatchesFamilies('/api/workspaces/b/reels', ['creators'], null)).toBe(true);
    for (const endpoint of ['creators', 'competitors', 'creator-directory', 'collection-summary', 'collection-status', 'status']) {
      expect(resourceMatchesFamilies(`/api/workspaces/a/${endpoint}`, ['jobs'])).toBe(true);
    }
    expect(resourceMatchesFamilies('/api/workspaces/a/reels', ['jobs'])).toBe(false);
    expect(resourceMatchesFamilies('/api/workspaces/a/carousel-summaries', ['saved_carousels'], 'a')).toBe(true);
    expect(resourceMatchesFamilies('/api/workspaces/a/carousel-summaries', ['saved_reels'], 'a')).toBe(false);
    expect(resourceMatchesFamilies('/api/workspaces/a/creators/id', ['saved_reels'], 'a')).toBe(false);
    expect(resourceMatchesFamilies('/api/workspaces/a/carousels/collection-status', ['jobs'])).toBe(true);
  });
  it('refreshes paged, singular and legacy creator counts on carousel changes without broadening directory/status/bookmark scopes', () => {
    for (const endpoint of ['competitors?search=test&page=3&limit=1', 'creators/id', 'creators']) {
      expect(resourceMatchesFamilies(`/api/workspaces/a/${endpoint}`, ['carousels'], 'a')).toBe(true);
      expect(resourceMatchesFamilies(`/api/workspaces/a/${endpoint}`, ['carousels'])).toBe(true);
      expect(resourceMatchesFamilies(`/api/workspaces/a/${endpoint}`, ['carousels'], 'b')).toBe(false);
      expect(resourceMatchesFamilies(`/api/workspaces/a/${endpoint}`, ['saved_carousels'], 'a')).toBe(false);
    }
    for (const endpoint of ['creator-directory', 'collection-summary', 'collection-status', 'creators/id/source-refresh']) {
      expect(resourceMatchesFamilies(`/api/workspaces/a/${endpoint}`, ['carousels'], 'a')).toBe(false);
    }
    expect(mutationResourceDependencies('/api/workspaces/a/carousels/refresh', 'POST')).toEqual({ families: ['jobs', 'settings', 'carousels'] });
  });
  it('maps supported writes centrally without response inspection', () => {
    expect(mutationResourceDependencies('/api/workspaces/a/saved', 'POST', JSON.stringify({ reel_id: 'id' }))).toEqual({ families: ['saved_reels'], workspaceId: 'a' });
    expect(mutationResourceDependencies('/api/workspaces/a/saved/id', 'PATCH')).toEqual({ families: ['saved_reels'], workspaceId: 'a' });
    expect(mutationResourceDependencies('/api/reel-filters/id', 'DELETE')).toEqual({ families: ['reel_filters'] });
    expect(mutationResourceDependencies('/api/carousel-filters', 'POST')).toEqual({ families: ['carousel_filters'] });
    expect(mutationResourceDependencies('/api/workspaces/a/carousels/id/saved', 'PUT')).toEqual({ families: ['saved_carousels'], workspaceId: 'a' });
    expect(mutationResourceDependencies('/api/workspaces/a/creators/import', 'POST', '{"preview":true}')).toEqual({ families: [] });
    expect(mutationResourceDependencies('/api/auth/realtime', 'POST')).toEqual({ families: [] });
    expect(mutationResourceDependencies('/api/future', 'POST')).toBeNull();
    expect(mutationResourceDependencies('/api/future', 'GET')).toEqual({ families: [] });
  });
});

describe('predicate union scheduling', () => {
  it('reloads creator counts on the existing carousel family event, coalescing bursts and leaving unrelated scoped reads warm', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const countPaths = ['/api/workspaces/a/competitors?page=2&limit=1', '/api/workspaces/a/creators/id', '/api/workspaces/a/creators',
      '/api/workspaces/b/competitors', '/api/workspaces/a/creator-directory', '/api/workspaces/a/collection-summary', '/api/reel-filters'];
    let count = 63;
    const load = vi.fn(async () => ({ tracked_carousels: count }));
    const cache = createResourceCache({ load }); caches.push(cache);
    countPaths.forEach(path => cache.subscribe(path, () => {})); await flush(); load.mockClear(); count = 64;
    cache.scheduleFamilyInvalidation(['carousels'], 'a');
    cache.scheduleFamilyInvalidation(['carousels'], 'a');
    vi.advanceTimersByTime(350); await flush();
    expect(load).toHaveBeenCalledTimes(3);
    countPaths.forEach((path, index) => expect(cache.getSnapshot(path).data).toEqual({ tracked_carousels: index < 3 ? 64 : 63 }));
    vi.advanceTimersByTime(1000); await flush(); expect(load).toHaveBeenCalledTimes(3);
    count = 65;
    cache.invalidateFamilies(['carousels']); await flush();
    expect(load).toHaveBeenCalledTimes(7);
    expect(cache.getSnapshot(countPaths[3]).data).toEqual({ tracked_carousels: 65 });
  });

  it('unions workspace bookmarks and independent presets in one bounded burst', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cache, reads } = await setup();
    cache.scheduleFamilyInvalidation(['saved_reels'], 'a');
    vi.advanceTimersByTime(200);
    cache.scheduleFamilyInvalidation(['reel_filters']);
    vi.advanceTimersByTime(350); await flush();
    expect(reads()).toEqual([...paths.slice(0, 4), '/api/reel-filters']);
    vi.advanceTimersByTime(2000); await flush(); expect(reads()).toHaveLength(5);
  });
  it('immediate scoped writes absorb only their scope, preserving other queued families', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cache, reads } = await setup();
    cache.scheduleFamilyInvalidation(['saved_reels'], 'a');
    cache.scheduleFamilyInvalidation(['carousel_filters']);
    cache.invalidateFamilies(['saved_reels'], 'a'); await flush();
    expect(reads()).toEqual(paths.slice(0, 4));
    vi.advanceTimersByTime(350); await flush();
    expect(reads()).toEqual([...paths.slice(0, 4), '/api/carousel-filters']);
  });
  it('events after an immediate refresh are not absorbed as older events', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cache, reads } = await setup();
    cache.scheduleFamilyInvalidation(['saved_reels'], 'a');
    cache.invalidateFamilies(['saved_reels'], 'a'); await flush();
    cache.scheduleFamilyInvalidation(['saved_reels'], 'a');
    vi.advanceTimersByTime(350); await flush(); expect(reads()).toHaveLength(8);
  });
  it('lets optimistic settlement own one refresh while preserving unrelated scheduled families', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cache, reads } = await setup();
    const settle = cache.optimisticUpdate(path => savedReelResourceMatches(path, 'a'), value => value);
    cache.scheduleFamilyInvalidation(['saved_reels'], 'a');
    cache.scheduleFamilyInvalidation(['carousel_filters']);
    cache.invalidateFamilies(['saved_reels'], 'a');
    await flush();
    expect(reads()).toEqual([]);
    settle(true); await flush();
    expect(reads()).toEqual(paths.slice(0, 4));
    vi.advanceTimersByTime(350); await flush();
    expect(reads()).toEqual([...paths.slice(0, 4), '/api/carousel-filters']);
    cache.scheduleFamilyInvalidation(['saved_reels'], 'a');
    vi.advanceTimersByTime(350); await flush();
    expect(reads()).toHaveLength(9);
  });

  it('full fallback dominates queued scopes and clear cancels every pending scope', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cache, reads, load } = await setup();
    cache.scheduleFamilyInvalidation(['reel_filters']); cache.scheduleInvalidation();
    cache.scheduleFamilyInvalidation(['carousel_filters']);
    vi.advanceTimersByTime(350); await flush(); expect(reads()).toEqual(paths);
    load.mockClear(); cache.scheduleFamilyInvalidation(['saved_reels'], 'a'); cache.clear();
    vi.advanceTimersByTime(2000); await flush(); expect(load).not.toHaveBeenCalled();
    paths.forEach(path => expect(cache.getSnapshot(path).data).toBeNull());
    paths.forEach(path => expect(cache.getServerSnapshot(path).data).toBeNull());
  });
  it('keeps dirty trailing reads scoped even when the current read fails', async () => {
    const requests: { path: string; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
    const cache = createResourceCache({ load: (path: string) => new Promise((resolve, reject) => requests.push({ path, resolve, reject })) }); caches.push(cache);
    cache.subscribe(paths[0], () => {}); cache.subscribe(paths[8], () => {}); await flush();
    cache.invalidateFamilies(['saved_reels'], 'a');
    requests[0].reject(new Error('temporary')); requests[1].resolve(['preset']); await flush();
    expect(requests.map(request => request.path)).toEqual([paths[0], paths[8], paths[0]]);
    requests[2].resolve({ items: ['fresh'] }); await flush();
    expect(cache.getSnapshot(paths[0]).data).toEqual({ items: ['fresh'] });
  });
});

describe('successful API mutation scoping and account epoch', () => {
  it('does not globally refresh after bookmarks or filter writes; unknown writes do', async () => {
    const fetch = vi.fn< (path: string, options?: RequestInit) => Promise<Response> >(async () => new Response('{}')); vi.stubGlobal('fetch', fetch);
    paths.forEach(path => cleanups.push(subscribeResource(path, () => {}))); await flush(); fetch.mockClear();
    await api('/api/workspaces/a/saved', { method: 'POST', body: '{"reel_id":"id"}' }); await flush();
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/workspaces/a/saved', ...paths.slice(0, 4)]);
    fetch.mockClear(); await api('/api/reel-filters', { method: 'POST', body: '{}' }); await flush();
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/reel-filters', '/api/reel-filters']);
    fetch.mockClear(); await api('/api/new-write', { method: 'POST' }); await flush();
    expect(fetch.mock.calls.map(call => call[0]).sort()).toEqual(['/api/new-write', ...paths].sort());
  });
  it('late mutation responses cannot restart reads after account clear', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((path: string, options?: RequestInit) => options?.method === 'POST'
      ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(new Response('{"owner":"old"}'))));
    cleanups.push(subscribeResource(paths[0], () => {})); await flush();
    const pending = api('/api/workspaces/a/saved', { method: 'POST' }); clearResourceCache();
    finish(new Response('{}')); await pending; await flush();
    expect(getResourceSnapshot(paths[0]).data).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
