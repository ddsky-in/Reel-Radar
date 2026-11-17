import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, MUTATION_REQUEST_TIMEOUT_MESSAGE, READ_REQUEST_TIMEOUT_MESSAGE, REQUEST_TIMEOUT_MS } from '../src/lib/client';
import { clearResourceCache, getResourceCacheEpoch, getResourceSnapshot, subscribeResource } from '../src/lib/resource-cache';
import { saveReel } from '../src/lib/reel-save';
import { createDemoData } from '../src/lib/demo';
import type { PageResult, Reel } from '../src/lib/types';

const cleanups: (() => void)[] = [];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function pendingFetch() {
  const pending = deferred<Response>();
  const fetch = vi.fn<(path: string, options: RequestInit) => Promise<Response>>(() => pending.promise);
  vi.stubGlobal('fetch', fetch);
  return { ...pending, fetch };
}
async function observe(paths: string[]) {
  paths.forEach(path => cleanups.push(subscribeResource(path, () => {})));
  await flush();
}
function readPaths(fetch: ReturnType<typeof pendingFetch>['fetch']) {
  return fetch.mock.calls.filter(([, options]) => !options.method || options.method === 'GET').map(([path]) => path);
}
function scopedFetch(value: unknown = { reconciled: true }) {
  const pending = deferred<Response>();
  const fetch = vi.fn<(path: string, options: RequestInit) => Promise<Response>>((_path, options) =>
    options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase()) ? pending.promise : Promise.resolve(response(value)));
  vi.stubGlobal('fetch', fetch);
  return { ...pending, fetch };
}

beforeEach(() => {
  clearResourceCache();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  clearResourceCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('API request deadline', () => {
  it('exports a fixed 30-second deadline and bounds a fetch that ignores abort', async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    const { fetch, resolve } = pendingFetch();
    const settled = vi.fn();
    const request = api('/api/bootstrap').finally(settled);
    const failed = expect(request).rejects.toMatchObject({ name: 'ApiError', code: 'REQUEST_TIMEOUT', status: 504, message: READ_REQUEST_TIMEOUT_MESSAGE });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(fetch.mock.calls[0][1].signal?.reason).toBeInstanceOf(ApiError);
    expect(vi.getTimerCount()).toBe(0);
    resolve(response({ late: true }));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it.each([200, 503])('covers stalled body parsing for HTTP %s within the same deadline', async status => {
    const body = deferred<unknown>();
    const fetchResult = deferred<Response>();
    const json = vi.fn(() => body.promise);
    const fetch = vi.fn(() => fetchResult.promise);
    vi.stubGlobal('fetch', fetch);
    const request = api('/api/bootstrap');
    const failed = expect(request).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', status: 504 });
    await vi.advanceTimersByTimeAsync(20_000);
    fetchResult.resolve({ ok: status === 200, status, json } as unknown as Response);
    await flush();
    expect(json).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetch.mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    body.resolve(status === 200 ? { late: true } : { error: { code: 'LATE_ERROR', message: 'Late error' } });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE', 'post'])('reports an ambiguous %s timeout without retrying', async method => {
    const { fetch, reject } = pendingFetch();
    const request = api('/api/workspaces/a/saved', { method });
    const failed = expect(request).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', status: 504, message: 'Request timed out. It may have completed. Refresh status before trying again.' });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    reject(new Error('Late network failure'));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 'GET', 'get', 'HEAD', 'OPTIONS'])('uses safe retry wording for read-only method %s without auto-retry', async method => {
    const { fetch } = pendingFetch();
    const failed = expect(api('/api/bootstrap', { method })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', message: READ_REQUEST_TIMEOUT_MESSAGE });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    await failed;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cleans the timer/listener after success and preserves request options', async () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const fetch = vi.fn<(path: string, options: RequestInit) => Promise<Response>>(async () => response({ saved: true }));
    vi.stubGlobal('fetch', fetch);
    const body = JSON.stringify({ reel_id: 'id' });
    await expect(api('/api/workspaces/a/saved', { method: 'POST', body, signal: caller.signal, headers: { 'X-Request': 'manual' } })).resolves.toEqual({ saved: true });
    expect(fetch).toHaveBeenCalledWith('/api/workspaces/a/saved', expect.objectContaining({
      method: 'POST', body, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Request': 'manual' }, signal: expect.any(AbortSignal),
    }));
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    caller.abort();
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('handles 204 without parsing a body or leaving a timer', async () => {
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204, json })));
    await expect(api('/api/workspaces/a/saved/id', { method: 'DELETE' })).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['api', 'invalid-json', 'network', 'invalid-error-json'])('preserves %s errors and cleans the deadline', async kind => {
    const expected = new Error(kind);
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (kind === 'network') throw expected;
      if (kind === 'api') return response({ error: { code: 'DENIED', message: 'Not allowed' } }, 403);
      return { ok: kind === 'invalid-json', status: kind === 'invalid-json' ? 200 : 502, json: () => Promise.reject(expected) } as unknown as Response;
    }));
    const request = api('/api/workspaces/a/saved', { method: 'POST' });
    if (kind === 'api') await expect(request).rejects.toMatchObject({ code: 'DENIED', status: 403, message: 'Not allowed' });
    else if (kind === 'invalid-error-json') await expect(request).rejects.toMatchObject({ code: 'REQUEST_FAILED', status: 502, message: 'Request failed (502). Please try again.' });
    else await expect(request).rejects.toBe(expected);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('caller cancellation', () => {
  it('honors an already aborted signal without starting fetch or a timer', async () => {
    const caller = new AbortController();
    caller.abort();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(api('/api/bootstrap', { signal: caller.signal })).rejects.toBe(caller.signal.reason);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('settles unmount cancellation even when fetch ignores abort (body pending: %s)', async bodyPending => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const body = deferred<unknown>();
    const pending = pendingFetch();
    const failed = expect(api('/api/workspaces/a/saved', { method: 'POST', signal: caller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    if (bodyPending) {
      pending.resolve({ ok: true, status: 200, json: () => body.promise } as unknown as Response);
      await flush();
    }
    caller.abort();
    await failed;
    expect(pending.fetch.mock.calls[0][1].signal?.reason).toBe(caller.signal.reason);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(response({ late: true }));
    body.resolve({ late: true });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(pending.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate visible resources or clear auth state on caller cancellation', async () => {
    const { fetch, resolve } = scopedFetch();
    await observe(['/api/bootstrap', '/api/workspaces/a/reels']);
    const epoch = getResourceCacheEpoch();
    const snapshots = ['/api/bootstrap', '/api/workspaces/a/reels'].map(path => getResourceSnapshot(path));
    fetch.mockClear();
    const caller = new AbortController();
    const failed = expect(api('/api/auth/logout', { method: 'POST', signal: caller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await failed;
    resolve(response({ signed_out: true }));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(getResourceCacheEpoch()).toBe(epoch);
    ['/api/bootstrap', '/api/workspaces/a/reels'].forEach((path, index) => expect(getResourceSnapshot(path)).toBe(snapshots[index]));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('mutation timeout reconciliation', () => {
  const paths = ['/api/workspaces/a/reels?saved=true', '/api/workspaces/a/reels/id', '/api/workspaces/a/overview',
    '/api/workspaces/a/creators', '/api/workspaces/a/collection-status', '/api/workspaces/b/reels',
    '/api/workspaces/a/reels/id/transcript', '/api/reel-filters', '/api/carousel-filters', '/api/bootstrap'];

  it.each([false, true])('invalidates only affected reads once and suppresses late POST effects (body pending: %s)', async bodyPending => {
    const pending = scopedFetch();
    const body = deferred<unknown>();
    await observe(paths);
    pending.fetch.mockClear();
    const failed = expect(api('/api/workspaces/a/saved', { method: 'POST', body: '{"reel_id":"id"}' })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    if (bodyPending) {
      pending.resolve({ ok: true, status: 200, json: () => body.promise } as unknown as Response);
      await flush();
    }
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    await flush();
    expect(readPaths(pending.fetch)).toEqual(paths.slice(0, 3));
    pending.resolve(response({ saved: true }));
    body.resolve({ saved: true });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(readPaths(pending.fetch)).toEqual(paths.slice(0, 3));
    expect(pending.fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  });

  it.each([
    ['/api/reel-filters', '/api/reel-filters'],
    ['/api/carousel-filters', '/api/carousel-filters'],
    ['/api/future-write', 'all'],
    ['/api/workspaces/a/creators/import', 'none'],
  ])('preserves known family targeting and unknown fallback for %s', async (path, expectedRead) => {
    const pending = scopedFetch();
    await observe(paths);
    pending.fetch.mockClear();
    const failed = expect(api(path, { method: 'POST', body: path.endsWith('/import') ? '{"preview":true}' : '{}' })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    await flush();
    expect(readPaths(pending.fetch)).toEqual(expectedRead === 'all' ? paths : expectedRead === 'none' ? [] : [expectedRead]);
    pending.resolve(response({ late: true }));
    await flush();
    expect(readPaths(pending.fetch)).toEqual(expectedRead === 'all' ? paths : expectedRead === 'none' ? [] : [expectedRead]);
  });

  it('does not retry/enqueue refresh work, release holds, or invent provider costs', async () => {
    const billing = { provider_cost_usd: null, cost_status: 'unknown', reserved_usd: 7, held_jobs: ['accepted-run'] };
    const pending = scopedFetch(billing);
    const affected = ['/api/jobs', '/api/settings', '/api/bootstrap', '/api/workspaces/a/creators'];
    await observe(affected);
    pending.fetch.mockClear();
    const failed = expect(api('/api/refresh', { method: 'POST', body: '{"workspace_id":"a"}' })).rejects.toMatchObject({ message: MUTATION_REQUEST_TIMEOUT_MESSAGE });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    await flush();
    expect(readPaths(pending.fetch)).toEqual(affected);
    affected.forEach(path => expect(getResourceSnapshot(path).data).toEqual(billing));
    pending.resolve(response({ job_id: 'possibly-accepted' }));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(pending.fetch.mock.calls).toHaveLength(affected.length + 1);
    expect(pending.fetch.mock.calls.filter(([, options]) => options.method)).toHaveLength(1);
  });

  it.each([false, true])('does not reconcile a prior account after epoch clear (new owner loaded: %s)', async nextOwner => {
    const pending = scopedFetch({ owner: 'old' });
    await observe(paths.slice(0, 3));
    pending.fetch.mockClear();
    const failed = expect(api('/api/workspaces/a/saved', { method: 'POST' })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    clearResourceCache();
    if (nextOwner) {
      pending.fetch.mockImplementation((_path, options) => options.method === 'POST' ? pending.promise : Promise.resolve(response({ owner: 'new' })));
      await observe(paths.slice(0, 3));
      pending.fetch.mockClear();
    }
    const epoch = getResourceCacheEpoch();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    pending.resolve(response({ owner: 'old', saved: true }));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(getResourceCacheEpoch()).toBe(epoch);
    expect(readPaths(pending.fetch)).toEqual([]);
    paths.slice(0, 3).forEach(path => expect(getResourceSnapshot(path).data).toEqual(nextOwner ? { owner: 'new' } : null));
  });

  it('releases existing Reel-save pending state and reconciles once without replaying the write', async () => {
    // The Reel fixture is synthetic demo data, not verified Instagram data.
    const reel = { ...createDemoData().reels[0], saved: false };
    const list = '/api/workspaces/a/reels';
    const pending = scopedFetch({ items: [reel], total: 1 });
    await observe([list]);
    pending.fetch.mockClear();
    const saving = saveReel('a', reel);
    expect(getResourceSnapshot<PageResult<Reel>>(list).data?.items[0].saved).toBe(true);
    expect(await saveReel('a', reel)).toBe(false);
    const failed = expect(saving).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', message: MUTATION_REQUEST_TIMEOUT_MESSAGE });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    await flush();
    expect(getResourceSnapshot<PageResult<Reel>>(list).data?.items[0].saved).toBe(false);
    expect(readPaths(pending.fetch)).toEqual([list]);
    pending.resolve(response({ saved: true }));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(getResourceSnapshot<PageResult<Reel>>(list).data?.items[0].saved).toBe(false);
    expect(pending.fetch.mock.calls).toHaveLength(2);
  });
});

describe('auth deadline isolation', () => {
  it.each(['/api/auth/login', '/api/auth/logout'])('discards ambiguous %s owner state without automatic auth recovery or late effects', async path => {
    const target = new EventTarget();
    const changed = vi.fn();
    target.addEventListener('reelradar-auth-change', changed);
    vi.stubGlobal('window', target);
    const pending = scopedFetch({ owner: 'old' });
    await observe(['/api/bootstrap', '/api/workspaces/a/reels']);
    pending.fetch.mockClear();
    const epoch = getResourceCacheEpoch();
    const failed = expect(api(path, { method: 'POST' })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', message: MUTATION_REQUEST_TIMEOUT_MESSAGE });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    expect(changed).toHaveBeenCalledTimes(1);
    expect(getResourceCacheEpoch()).toBe(epoch + 1);
    ['/api/bootstrap', '/api/workspaces/a/reels'].forEach(resource => expect(getResourceSnapshot(resource).data).toBeNull());
    expect(pending.fetch).toHaveBeenCalledTimes(1);
    // An explicitly loaded new account must not be cleared by old auth success.
    pending.fetch.mockImplementation((_path, options) => options.method === 'POST' ? pending.promise : Promise.resolve(response({ owner: 'new' })));
    await observe(['/api/bootstrap', '/api/workspaces/a/reels']);
    pending.resolve(response({ signed_in: true, signed_out: true }));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(getResourceCacheEpoch()).toBe(epoch + 1);
    ['/api/bootstrap', '/api/workspaces/a/reels'].forEach(resource => expect(getResourceSnapshot(resource).data).toEqual({ owner: 'new' }));
    expect(pending.fetch.mock.calls.filter(([, options]) => options.method)).toHaveLength(1);
    expect(pending.fetch.mock.calls).toHaveLength(3);
  });

  it.each(['/api/auth/login', '/api/auth/logout'])('cannot clear or restart a new account when old %s times out', async path => {
    const target = new EventTarget();
    const changed = vi.fn();
    target.addEventListener('reelradar-auth-change', changed);
    vi.stubGlobal('window', target);
    const pending = scopedFetch({ owner: 'old' });
    await observe(['/api/bootstrap']);
    const failed = expect(api(path, { method: 'POST' })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    clearResourceCache();
    pending.fetch.mockImplementation((_path, options) => options.method === 'POST' ? pending.promise : Promise.resolve(response({ owner: 'new' })));
    await observe(['/api/bootstrap']);
    const epoch = getResourceCacheEpoch();
    pending.fetch.mockClear();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    pending.resolve(response({ late: true }));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(changed).not.toHaveBeenCalled();
    expect(getResourceCacheEpoch()).toBe(epoch);
    expect(getResourceSnapshot('/api/bootstrap').data).toEqual({ owner: 'new' });
    expect(pending.fetch).not.toHaveBeenCalled();
  });

  it('keeps confirmed auth success behavior and does not clear on a definitive auth error', async () => {
    const target = new EventTarget();
    const changed = vi.fn();
    target.addEventListener('reelradar-auth-change', changed);
    vi.stubGlobal('window', target);
    const pending = scopedFetch();
    await observe(['/api/bootstrap']);
    const epoch = getResourceCacheEpoch();
    pending.fetch.mockImplementation(async () => response({ error: { code: 'INVALID_LOGIN', message: 'Invalid credentials' } }, 401));
    await expect(api('/api/auth/login', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'INVALID_LOGIN' });
    expect(changed).not.toHaveBeenCalled();
    expect(getResourceCacheEpoch()).toBe(epoch);
    expect(getResourceSnapshot('/api/bootstrap').data).toEqual({ reconciled: true });
    pending.fetch.mockImplementation(async () => new Response(null, { status: 204 }));
    await expect(api('/api/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(getResourceCacheEpoch()).toBe(epoch + 1);
    expect(getResourceSnapshot('/api/bootstrap').data).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
