import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourceCache, type ResourceCacheOptions } from '../src/lib/resource-cache';

type Deferred = {
  path: string;
  signal: AbortSignal;
  resolve: (data: unknown) => void;
  reject: (error: unknown) => void;
};

const caches: ReturnType<typeof createResourceCache>[] = [];
function setup(options: Omit<ResourceCacheOptions, 'load'> = {}) {
  const requests: Deferred[] = [];
  const load = vi.fn((path: string, signal: AbortSignal) => new Promise<unknown>((resolve, reject) => {
    requests.push({ path, signal, resolve, reject });
  }));
  const cache = createResourceCache({ ...options, load });
  caches.push(cache);
  return { cache, requests, load };
}

async function flush() {
  // Drain deferred loaders, request settlement, trailing requests and batched notifications.
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

afterEach(() => {
  for (const cache of caches.splice(0)) cache.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('background read backpressure', () => {
  it('coalesces repeated background signals with exponential cooldown while preserving last-good data', async () => {
    vi.useFakeTimers();
    const { cache, requests, load } = setup({ debounceMs: 10, maxWaitMs: 20 });
    const path = '/api/bootstrap';
    cache.subscribe(path, () => {}); await flush();
    requests[0].resolve({ saved: true }); await flush();
    cache.scheduleInvalidation(); vi.advanceTimersByTime(20); await flush();
    requests[1].reject(new Error('Temporary database failure')); await flush();
    for (let i = 0; i < 20; i++) cache.scheduleInvalidation();
    vi.advanceTimersByTime(999); await flush();
    expect(load).toHaveBeenCalledTimes(2); expect(cache.getSnapshot(path).data).toEqual({ saved: true });
    vi.advanceTimersByTime(1); await flush(); expect(load).toHaveBeenCalledTimes(3);
    requests[2].reject(new Error('Still unavailable')); await flush();
    cache.scheduleInvalidation(); vi.advanceTimersByTime(1999); await flush();
    expect(load).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1); await flush(); expect(load).toHaveBeenCalledTimes(4);
    requests[3].resolve({ saved: 'updated' }); await flush();
    cache.scheduleInvalidation(); vi.advanceTimersByTime(20); await flush();
    expect(load).toHaveBeenCalledTimes(5);
  });
  it('lets manual retry bypass cooldown and cancels deferred reads when the owner cache clears', async () => {
    vi.useFakeTimers();
    const { cache, requests, load } = setup({ debounceMs: 10 });
    const path = '/api/bootstrap'; cache.subscribe(path, () => {}); await flush();
    requests[0].reject(new Error('Unavailable')); await flush();
    cache.scheduleInvalidation(); vi.advanceTimersByTime(10); await flush();
    cache.invalidate(path); await flush(); expect(load).toHaveBeenCalledTimes(2);
    requests[1].reject(new Error('Unavailable')); await flush();
    cache.scheduleInvalidation(); vi.advanceTimersByTime(10); await flush();
    cache.clear(); vi.advanceTimersByTime(60_000); await flush();
    expect(load).toHaveBeenCalledTimes(2); expect(cache.getSnapshot(path).data).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('bounded resource request deadlines', () => {
  const path = '/api/workspaces/a/carousels';
  const timeoutError = 'Loading took too long. Please try again.';
  const useDeadlineTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  it('ends a hung initial GET at the default 20-second deadline without retrying forever', async () => {
    useDeadlineTimers();
    const { cache, requests, load } = setup();
    const changed = vi.fn();
    cache.subscribe(path, changed);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(19_999);
    await flush();
    expect(cache.getSnapshot(path).loading).toBe(true);
    expect(requests[0].signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(requests[0].signal.aborted).toBe(true);
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: null, loading: false, refreshing: false, error: timeoutError });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('allows immediate exact-path retry and ignores the timed-out loader when it later %ss', async settlement => {
    useDeadlineTimers();
    const { cache, requests, load } = setup({ requestTimeoutMs: 100 });
    cache.subscribe(path, () => {});
    cache.subscribe('/api/workspaces/b/carousels', () => {});
    await flush();
    requests[1].resolve({ otherWorkspace: true });
    await flush();
    vi.advanceTimersByTime(100);
    // Retry in the timer's turn, before any loader rejection can settle.
    cache.invalidate(path);
    expect(cache.getSnapshot(path)).toEqual({ data: null, loading: true, refreshing: false, error: null });
    await flush();
    expect(requests.map(request => request.path)).toEqual([path, '/api/workspaces/b/carousels', path]);
    if (settlement === 'resolve') requests[0].resolve({ obsolete: true });
    else requests[0].reject(new Error('Late failure'));
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: null, loading: true, refreshing: false, error: null });
    requests[2].resolve({ current: true });
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: { current: true }, loading: false, refreshing: false, error: null });
    expect(cache.getSnapshot('/api/workspaces/b/carousels').data).toEqual({ otherWorkspace: true });
    vi.advanceTimersByTime(1000);
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains last-good sidebar data after a refresh timeout and gives a retry its own deadline', async () => {
    useDeadlineTimers();
    const { cache, requests, load } = setup({ requestTimeoutMs: 100 });
    const sidebar = '/api/bootstrap';
    cache.subscribe(sidebar, () => {});
    await flush();
    const good = { workspaces: [{ id: 'a' }] };
    requests[0].resolve(good);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(80);
    cache.invalidate(sidebar);
    await flush();
    expect(cache.getSnapshot(sidebar)).toEqual({ data: good, loading: false, refreshing: true, error: null });
    vi.advanceTimersByTime(99);
    await flush();
    expect(requests[1].signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    await flush();
    expect(cache.getSnapshot(sidebar)).toEqual({ data: good, loading: false, refreshing: false, error: timeoutError });
    cache.invalidate(sidebar);
    await flush();
    expect(cache.getSnapshot(sidebar)).toEqual({ data: good, loading: false, refreshing: true, error: null });
    vi.advanceTimersByTime(99);
    await flush();
    requests[1].resolve({ obsolete: true });
    await flush();
    expect(cache.getSnapshot(sidebar).data).toBe(good);
    requests[2].resolve({ workspaces: [{ id: 'a' }, { id: 'b' }] });
    await flush();
    vi.advanceTimersByTime(1);
    await flush();
    expect(cache.getSnapshot(sidebar)).toEqual({ data: { workspaces: [{ id: 'a' }, { id: 'b' }] }, loading: false, refreshing: false, error: null });
    expect(load).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires one dirty hung read, then performs exactly one trailing refresh without an abort storm', async () => {
    useDeadlineTimers();
    const { cache, requests, load } = setup({ requestTimeoutMs: 100 });
    cache.subscribe(path, () => {});
    await flush();
    vi.advanceTimersByTime(50);
    for (let index = 0; index < 10; index++) cache.invalidate(path);
    expect(requests[0].signal.aborted).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(49);
    await flush();
    expect(requests[0].signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    // Events before the deferred trailing GET are covered by that read.
    for (let index = 0; index < 10; index++) cache.invalidate(path);
    await flush();
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].signal.aborted).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.getSnapshot(path)).toEqual({ data: null, loading: true, refreshing: false, error: null });
    requests[0].resolve({ obsolete: true });
    await flush();
    expect(cache.getSnapshot(path).data).toBeNull();
    requests[1].resolve({ fresh: true });
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: { fresh: true }, loading: false, refreshing: false, error: null });
    expect(load).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops with a retryable error if the one dirty trailing refresh also hangs', async () => {
    useDeadlineTimers();
    const { cache, requests, load } = setup({ requestTimeoutMs: 100, debounceMs: 25, maxWaitMs: 75 });
    cache.subscribe(path, () => {});
    await flush();
    cache.scheduleFamilyInvalidation(['carousels'], 'a');
    // The event is dirty, not a restart of the original deadline.
    vi.advanceTimersByTime(25);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(requests[0].signal.aborted).toBe(false);
    vi.advanceTimersByTime(75);
    await flush();
    // A background event preserves the failed read's retry cooldown.
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(requests[0].signal.aborted).toBe(true);
    vi.advanceTimersByTime(100);
    await flush();
    expect(requests[1].signal.aborted).toBe(true);
    expect(cache.getSnapshot(path)).toEqual({ data: null, loading: false, refreshing: false, error: timeoutError });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate an initial GET when fake timers flush invalidation before the deferred loader', async () => {
    useDeadlineTimers();
    const { cache, requests, load } = setup({ requestTimeoutMs: 100 });
    cache.subscribe(path, () => {});
    cache.scheduleInvalidation();
    vi.advanceTimersByTime(350);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(requests[0].signal.aborted).toBe(false);
    requests[0].resolve({ current: true });
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot(path).data).toEqual({ current: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('absorbs an invalidation from settlement notification into the already queued trailing GET', async () => {
    useDeadlineTimers();
    const { cache, requests, load } = setup({ requestTimeoutMs: 100 });
    let invalidatedFromSettlement = false;
    cache.subscribe(path, () => {
      if (cache.getSnapshot(path).data !== null && !invalidatedFromSettlement) {
        invalidatedFromSettlement = true;
        cache.invalidate(path);
      }
    });
    await flush();
    cache.invalidate(path);
    requests[0].resolve({ version: 1 });
    await flush();
    expect(invalidatedFromSettlement).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    requests[1].resolve({ version: 2 });
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: { version: 2 }, loading: false, refreshing: false, error: null });
    expect(load).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves Strict Mode deferral and cancels the deadline only after the last observer leaves', async () => {
    useDeadlineTimers();
    const { cache, requests, load } = setup({ requestTimeoutMs: 100 });
    const probe = cache.subscribe(path, () => {});
    probe();
    const first = cache.subscribe(path, () => {});
    const second = cache.subscribe(path, () => {});
    expect(vi.getTimerCount()).toBe(0);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    first();
    expect(requests[0].signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    second();
    expect(requests[0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    requests[0].reject(new DOMException('Aborted', 'AbortError'));
    vi.advanceTimersByTime(1000);
    await flush();
    expect(cache.getSnapshot(path).error).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('cancels hung-request and event timers on logout, with no late owner data or unauthenticated refetch', async () => {
    useDeadlineTimers();
    const { cache, requests, load } = setup({ requestTimeoutMs: 100 });
    cache.subscribe(path, () => {});
    await flush();
    requests[0].resolve({ owner: 'old' });
    await flush();
    cache.invalidate(path);
    await flush();
    cache.invalidate(path); // Dirty requests must not restart after clear.
    const settle = cache.optimisticUpdate(current => current === path, data => data);
    cache.scheduleInvalidation();
    expect(vi.getTimerCount()).toBe(3);
    const epoch = cache.getEpoch();
    cache.clear();
    expect(cache.getEpoch()).toBe(epoch + 1);
    expect(requests[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    settle(true);
    requests[1].resolve({ owner: 'late-old' });
    vi.advanceTimersByTime(1000);
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: null, loading: true, refreshing: false, error: null });
    expect(cache.getServerSnapshot(path).data).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    cache.invalidate(path);
    await flush();
    requests[2].resolve({ owner: 'new' });
    await flush();
    expect(cache.getSnapshot(path).data).toEqual({ owner: 'new' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timeout behind when an unobserved hung entry is pruned', async () => {
    useDeadlineTimers();
    const { cache, requests, load } = setup({ maxEntries: 1, requestTimeoutMs: 100 });
    const leave = cache.subscribe(path, () => {});
    await flush();
    leave();
    cache.subscribe('/api/bootstrap', () => {});
    await flush();
    expect(requests[0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    requests[0].resolve({ obsolete: true });
    requests[1].resolve({ current: true });
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(cache.getSnapshot(path).error).toBeNull();
    expect(cache.getSnapshot(path).data).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('retains overlapping optimistic layers across timeout and settlement (commit=%s)', async commit => {
    useDeadlineTimers();
    const { cache, requests, load } = setup({ requestTimeoutMs: 100 });
    cache.subscribe(path, () => {});
    await flush();
    const good = { first: false, second: false };
    requests[0].resolve(good);
    await flush();
    cache.invalidate(path);
    await flush();
    const first = cache.optimisticUpdate(current => current === path, data => ({ ...(data as object), first: true }));
    const second = cache.optimisticUpdate(current => current === path, data => ({ ...(data as object), second: true }));
    cache.invalidate(path);
    vi.advanceTimersByTime(100);
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: { first: true, second: true }, loading: false, refreshing: false, error: timeoutError });
    expect(load).toHaveBeenCalledTimes(2);
    first(commit);
    await flush();
    expect(cache.getSnapshot(path).data).toEqual({ first: commit, second: true });
    requests[1].resolve({ first: false, second: false, obsolete: true });
    await flush();
    expect(cache.getSnapshot(path).data).toEqual({ first: commit, second: true });
    requests[2].resolve({ first: commit, second: false });
    await flush();
    expect(cache.getSnapshot(path).data).toEqual({ first: commit, second: true });
    second(false);
    await flush();
    expect(cache.getSnapshot(path).data).toEqual({ first: commit, second: false });
    requests[3].resolve({ first: commit, second: false });
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: { first: commit, second: false }, loading: false, refreshing: false, error: null });
    expect(load).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles successful null or empty responses without retaining a deadline or refetching for another observer', async () => {
    useDeadlineTimers();
    const { cache, requests, load } = setup({ requestTimeoutMs: 100 });
    cache.subscribe(path, () => {});
    await flush();
    requests[0].resolve(null);
    await flush();
    cache.subscribe(path, () => {});
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: null, loading: false, refreshing: false, error: null });
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    cache.invalidate(path);
    await flush();
    expect(cache.getSnapshot(path).refreshing).toBe(true);
    requests[1].resolve(undefined);
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: null, loading: false, refreshing: false, error: null });
    expect(load).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the deadline for synchronous loader failures and never allocates one for disabled queries', async () => {
    useDeadlineTimers();
    const load = vi.fn(() => { throw new Error('Synchronous failure'); });
    const cache = createResourceCache({ load, requestTimeoutMs: 100 });
    caches.push(cache);
    cache.subscribe(null, () => {})();
    cache.invalidate();
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(cache.getSnapshot(null)).toEqual({ data: null, loading: false, refreshing: false, error: null });
    cache.subscribe(path, () => {});
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: null, loading: false, refreshing: false, error: 'Synchronous failure' });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot(path).error).toBe('Synchronous failure');
  });

  it.each(['fetch', 'body'] as const)('bounds the authenticated default loader while %s hangs and preserves a friendly timeout over AbortError', async phase => {
    useDeadlineTimers();
    const fetch = vi.fn((_path: string, options: RequestInit) => {
      const aborted = new Promise<never>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return phase === 'fetch' ? aborted : Promise.resolve({ ok: true, status: 200, json: () => aborted });
    });
    vi.stubGlobal('fetch', fetch);
    const cache = createResourceCache({ requestTimeoutMs: 100 });
    caches.push(cache);
    cache.subscribe(path, () => {});
    await flush();
    expect(fetch).toHaveBeenCalledWith(path, { signal: expect.any(AbortSignal), credentials: 'same-origin', cache: 'no-store' });
    vi.advanceTimersByTime(100);
    await flush();
    expect(cache.getSnapshot(path)).toEqual({ data: null, loading: false, refreshing: false, error: timeoutError });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('shared background resource cache', () => {
  it('keeps render/server snapshots stable and never fetches until subscribed', async () => {
    const { cache, load } = setup();
    const initial = cache.getSnapshot('/api/one');
    expect(cache.getSnapshot('/api/one')).toBe(initial);
    expect(initial).toEqual({ data: null, loading: true, refreshing: false, error: null });
    expect(cache.getSnapshot(null)).toEqual({ data: null, loading: false, refreshing: false, error: null });
    expect(cache.getServerSnapshot('/api/one')).toBe(cache.getServerSnapshot('/api/one'));
    await flush();
    expect(load).not.toHaveBeenCalled();
  });

  it('deduplicates identical paths across observers and batches changed notifications', async () => {
    const { cache, requests, load } = setup();
    const first = vi.fn(), second = vi.fn();
    const unsubscribe = cache.subscribe('/api/one', first);
    const unsubscribeSecond = cache.subscribe('/api/one', second);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled(); // Unchanged initial loading state.
    const data = { items: [1] };
    requests[0].resolve(data);
    await flush();
    expect(cache.getSnapshot('/api/one').data).toBe(data);
    expect(cache.getSnapshot('/api/one')).toBe(cache.getSnapshot('/api/one'));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(requests[0].signal.aborted).toBe(false);
    unsubscribeSecond();
  });

  it('retains last-good data during refresh and failure, and allows retry', async () => {
    const { cache, requests } = setup();
    cache.subscribe('/api/one', () => {});
    await flush();
    const good = { total: 7 };
    requests[0].resolve(good);
    await flush();
    cache.invalidate('/api/one');
    expect(cache.getSnapshot('/api/one')).toEqual({ data: good, loading: false, refreshing: true, error: null });
    await flush();
    requests[1].reject(new Error('Offline'));
    await flush();
    expect(cache.getSnapshot('/api/one')).toEqual({ data: good, loading: false, refreshing: false, error: 'Offline' });
    cache.invalidate('/api/one');
    expect(cache.getSnapshot('/api/one').data).toBe(good);
    expect(cache.getSnapshot('/api/one').error).toBeNull();
    await flush();
    requests[2].resolve({ total: 8 });
    await flush();
    expect(cache.getSnapshot('/api/one').data).toEqual({ total: 8 });
  });

  it('exposes an initial error without a permanent loading skeleton', async () => {
    const { cache, requests } = setup();
    cache.subscribe('/api/one', () => {});
    await flush();
    requests[0].reject(new Error('Permission denied'));
    await flush();
    expect(cache.getSnapshot('/api/one')).toEqual({ data: null, loading: false, refreshing: false, error: 'Permission denied' });
  });

  it('keeps workspace/query keys separate, with no data carried into a new path', async () => {
    const { cache, requests } = setup();
    cache.subscribe('/api/workspaces/a/reels?sort=views', () => {});
    await flush();
    requests[0].resolve({ workspace: 'a' });
    await flush();
    const nextPath = '/api/workspaces/b/reels?sort=views';
    expect(cache.getSnapshot(nextPath).data).toBeNull();
    cache.subscribe(nextPath, () => {});
    cache.subscribe('/api/workspaces/a/reels?sort=likes', () => {});
    await flush();
    expect(requests.map(request => request.path)).toEqual([
      '/api/workspaces/a/reels?sort=views', nextPath, '/api/workspaces/a/reels?sort=likes',
    ]);
    cache.invalidate(nextPath);
    expect(cache.getSnapshot('/api/workspaces/a/reels?sort=views').refreshing).toBe(false);
    expect(cache.getSnapshot(nextPath).data).toBeNull();
  });

  it('coalesces repeated in-flight invalidations into one trailing request', async () => {
    const { cache, requests, load } = setup();
    const changed = vi.fn();
    cache.subscribe('/api/one', changed);
    await flush();
    for (let index = 0; index < 10; index++) cache.invalidate('/api/one');
    expect(requests[0].signal.aborted).toBe(false);
    requests[0].resolve({ version: 1 });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1); // Settlement + trailing refresh form one batch.
    expect(cache.getSnapshot('/api/one')).toEqual({ data: { version: 1 }, loading: false, refreshing: true, error: null });
    requests[1].resolve({ version: 2 });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.getSnapshot('/api/one').data).toEqual({ version: 2 });
    expect(cache.getSnapshot('/api/one').refreshing).toBe(false);
  });

  it('preserves a trailing invalidation even when the in-flight request fails', async () => {
    const { cache, requests, load } = setup();
    cache.subscribe('/api/one', () => {});
    await flush();
    cache.invalidate();
    requests[0].reject(new Error('Temporary failure'));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    requests[1].resolve({ recovered: true });
    await flush();
    expect(cache.getSnapshot('/api/one').data).toEqual({ recovered: true });
  });

  it('debounces event bursts for 350ms and refreshes all active paths once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cache, requests, load } = setup();
    cache.subscribe('/api/one', () => {});
    cache.subscribe('/api/two', () => {});
    await flush();
    requests[0].resolve(1);
    requests[1].resolve(2);
    await flush();
    cache.scheduleInvalidation();
    vi.advanceTimersByTime(200);
    cache.scheduleInvalidation();
    vi.advanceTimersByTime(349);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await flush();
    expect(load).toHaveBeenCalledTimes(4);
    requests[2].resolve(3);
    requests[3].resolve(4);
    await flush();
    vi.advanceTimersByTime(2000);
    await flush();
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('enforces 1000ms maximum wait during a continuous event stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cache, requests, load } = setup();
    cache.subscribe('/api/one', () => {});
    await flush();
    requests[0].resolve(1);
    await flush();
    cache.scheduleInvalidation();
    for (let index = 0; index < 3; index++) {
      vi.advanceTimersByTime(300);
      cache.scheduleInvalidation();
    }
    vi.advanceTimersByTime(99);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    requests[1].resolve(2);
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not drop a debounced event that fires while a GET is pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cache, requests, load } = setup();
    cache.subscribe('/api/one', () => {});
    await flush();
    cache.scheduleInvalidation();
    vi.advanceTimersByTime(350);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    requests[0].resolve(1);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('absorbs scheduled bursts into an immediate successful-mutation invalidation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cache, requests, load } = setup();
    cache.subscribe('/api/one', () => {});
    await flush();
    requests[0].resolve(1);
    await flush();
    cache.scheduleInvalidation();
    cache.invalidate();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    requests[1].resolve(2);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('aborts only after the last observer leaves and ignores obsolete late results', async () => {
    const { cache, requests, load } = setup();
    const first = cache.subscribe('/api/one', () => {});
    const second = cache.subscribe('/api/one', () => {});
    await flush();
    first();
    expect(requests[0].signal.aborted).toBe(false);
    second();
    expect(requests[0].signal.aborted).toBe(true);
    cache.subscribe('/api/one', () => {});
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    requests[0].resolve({ obsolete: true });
    await flush();
    expect(cache.getSnapshot('/api/one').data).toBeNull();
    requests[1].resolve({ current: true });
    await flush();
    expect(cache.getSnapshot('/api/one').data).toEqual({ current: true });
  });

  it('retains cached data on unmount and revisits with a background refresh', async () => {
    const { cache, requests } = setup();
    const unsubscribe = cache.subscribe('/api/one', () => {});
    await flush();
    requests[0].resolve({ saved: true });
    await flush();
    unsubscribe();
    expect(cache.getSnapshot('/api/one').data).toEqual({ saved: true });
    cache.invalidate('/api/one'); // Inactive resources remain lazy.
    await flush();
    expect(requests).toHaveLength(1);
    cache.subscribe('/api/one', () => {});
    expect(cache.getSnapshot('/api/one')).toEqual({ data: { saved: true }, loading: false, refreshing: true, error: null });
    await flush();
    expect(requests).toHaveLength(2);
  });

  it('does not issue obsolete requests for a Strict Mode subscription probe', async () => {
    const { cache, load } = setup();
    const unsubscribe = cache.subscribe('/api/one', () => {});
    unsubscribe();
    cache.subscribe('/api/one', () => {});
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('logout clears data/errors, aborts requests, cancels events and preserves mounted registrations', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cache, requests, load } = setup();
    const changed = vi.fn();
    cache.subscribe('/api/one', changed);
    const leaveTwo = cache.subscribe('/api/two', () => {});
    await flush();
    requests[0].resolve({ privateOwner: 'a' });
    requests[1].resolve({ privateOwner: 'a' });
    await flush();
    leaveTwo();
    cache.invalidate('/api/one');
    await flush();
    cache.scheduleInvalidation();
    changed.mockClear();
    cache.clear();
    expect(requests[2].signal.aborted).toBe(true);
    expect(cache.getSnapshot('/api/one').data).toBeNull();
    expect(cache.getSnapshot('/api/two').data).toBeNull();
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    requests[2].resolve({ privateOwner: 'a-late' });
    vi.advanceTimersByTime(2000);
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
    expect(cache.getSnapshot('/api/one').data).toBeNull();
    cache.invalidate(); // Owner change/sign-in can explicitly resume mounted reads.
    await flush();
    requests[3].resolve({ privateOwner: 'b' });
    await flush();
    expect(cache.getSnapshot('/api/one').data).toEqual({ privateOwner: 'b' });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(cache.getServerSnapshot('/api/one').data).toBeNull();
  });

  it('handles abort-related rejection without restoring old errors', async () => {
    const { cache, requests } = setup();
    const unsubscribe = cache.subscribe('/api/one', () => {});
    await flush();
    unsubscribe();
    requests[0].reject(new DOMException('Aborted', 'AbortError'));
    await flush();
    expect(cache.getSnapshot('/api/one').error).toBeNull();
  });

  it('bounds cached inactive paths with LRU eviction while preserving active data', async () => {
    const { cache, requests } = setup({ maxEntries: 2 });
    cache.subscribe('/api/active', () => {});
    await flush();
    requests[0].resolve({ active: true });
    await flush();
    const leaveOld = cache.subscribe('/api/old', () => {});
    await flush();
    requests[1].resolve({ old: true });
    await flush();
    leaveOld();
    const leaveNew = cache.subscribe('/api/new', () => {});
    await flush();
    requests[2].resolve({ recent: true });
    await flush();
    leaveNew();
    expect(cache.getSnapshot('/api/old').data).toBeNull();
    expect(cache.getSnapshot('/api/new').data).toEqual({ recent: true });
    expect(cache.getSnapshot('/api/active').data).toEqual({ active: true });
  });

  it('supports disabled nullable queries without listeners, fetches or loading', async () => {
    const { cache, load } = setup();
    const changed = vi.fn();
    const unsubscribe = cache.subscribe(null, changed);
    cache.invalidate();
    unsubscribe();
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(cache.getSnapshot(null)).toBe(cache.getSnapshot(null));
    expect(cache.getSnapshot(null)).toEqual({ data: null, loading: false, refreshing: false, error: null });
    expect(cache.getServerSnapshot(null)).toBe(cache.getSnapshot(null));
  });

  it('catches synchronously thrown loader failures as resource errors', async () => {
    const cache = createResourceCache({ load: () => { throw new Error('Synchronous failure'); } });
    caches.push(cache);
    cache.subscribe('/api/one', () => {});
    await flush();
    expect(cache.getSnapshot('/api/one')).toEqual({ data: null, loading: false, refreshing: false, error: 'Synchronous failure' });
  });

  it('clears a deferred initial request before it can load or notify an old owner', async () => {
    const { cache, load } = setup();
    const changed = vi.fn();
    cache.subscribe('/api/one', changed);
    cache.clear();
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(cache.getSnapshot('/api/one').data).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('bounds the default cache at 100 paths without evicting the most recent path', async () => {
    const { cache, requests } = setup();
    for (let index = 0; index < 101; index++) {
      const unsubscribe = cache.subscribe(`/api/${index}`, () => {});
      await flush();
      requests[index].resolve({ index });
      await flush();
      unsubscribe();
    }
    expect(cache.getSnapshot('/api/0').data).toBeNull();
    expect(cache.getSnapshot('/api/1').data).toEqual({ index: 1 });
    expect(cache.getSnapshot('/api/100').data).toEqual({ index: 100 });
  });

  it('uses same-origin/no-store authenticated GETs and existing API error messages', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Not your workspace' } }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const cache = createResourceCache();
    caches.push(cache);
    cache.subscribe('/api/workspaces/a/reels', () => {});
    await flush();
    expect(fetch).toHaveBeenCalledWith('/api/workspaces/a/reels', {
      signal: expect.any(AbortSignal), credentials: 'same-origin', cache: 'no-store',
    });
    expect(cache.getSnapshot('/api/workspaces/a/reels').error).toBe('Not your workspace');
    cache.invalidate();
    await flush();
    expect(cache.getSnapshot('/api/workspaces/a/reels').data).toEqual({ ok: true });
  });
});
