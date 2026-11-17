import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearResourceCache, getResourceSnapshot, invalidateResources, subscribeResource } from '../src/lib/resource-cache';
import { saveReel, setReelCompletion } from '../src/lib/reel-save';
import type { PageResult, Reel, ReelDetail } from '../src/lib/types';
import { createDemoData } from '../src/lib/demo';

type Request = { path: string; options: RequestInit; resolve: (response: Response) => void };
const cleanups: (() => void)[] = [];
const reel = { ...createDemoData().reels[0], saved: false };
const otherReel = { ...reel, id: 'other-reel' };
const list = '/api/workspaces/a/reels?sort=views';
const detail = `/api/workspaces/a/reels/${reel.id}`;
const overview = '/api/workspaces/a/overview';
const other = '/api/workspaces/ab/reels';
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function setup() {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', vi.fn((path: string, options: RequestInit) => new Promise<Response>(resolve => requests.push({ path, options, resolve }))));
  return requests;
}
async function seed(requests: Request[], paths = [list]) {
  for (const path of paths) cleanups.push(subscribeResource(path, () => {}));
  await flush();
  for (const request of requests) request.resolve(response(request.path === detail ? { reel } : request.path === overview ? { recent: [reel] } : { items: [reel, otherReel], total: 2 }));
  await flush();
}
function saved(path = list) { return getResourceSnapshot<PageResult<Reel>>(path).data?.items[0]?.saved; }
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  clearResourceCache();
  vi.unstubAllGlobals();
});

describe('optimistic Reel saves', () => {
  it('updates completion immediately across this workspace and rolls back a denied write', async () => {
    const requests = setup();
    const savedReel: Reel = { ...reel, saved: true, completion_status: 'pending' };
    for (const path of [list, detail, other]) cleanups.push(subscribeResource(path, () => {}));
    await flush();
    for (const request of requests) request.resolve(response(request.path === detail ? { reel: savedReel } : { items: [savedReel], total: 1 }));
    await flush();
    const update = setReelCompletion('a', savedReel);
    expect(getResourceSnapshot<PageResult<Reel>>(list).data?.items[0].completion_status).toBe('done');
    expect(getResourceSnapshot<ReelDetail>(detail).data?.reel.completion_status).toBe('done');
    expect(getResourceSnapshot<PageResult<Reel>>(other).data?.items[0].completion_status).toBe('pending');
    expect(await setReelCompletion('a', savedReel)).toBe(false);
    expect(await saveReel('a', savedReel)).toBe(false);
    const rejected = expect(update).rejects.toThrow('Completion could not be saved');
    const write = requests.find(item => item.options.method === 'PATCH')!;
    expect(write.path).toBe(`/api/workspaces/a/saved/${reel.id}`);
    expect(write.options.body).toBe(JSON.stringify({ completion_status: 'done' }));
    write.resolve(response({ error: { message: 'Completion could not be saved' } }, 403));
    await rejected;
    expect(getResourceSnapshot<ReelDetail>(detail).data?.reel.completion_status).toBe('pending');
  });

  it('updates all loaded workspace views before the write resolves and suppresses duplicate clicks', async () => {
    const requests = setup();
    await seed(requests, [list, detail, overview, other]);
    const saving = saveReel('a', reel);
    expect(saved()).toBe(true);
    expect(getResourceSnapshot<ReelDetail>(detail).data?.reel.saved).toBe(true);
    expect(getResourceSnapshot<{ recent: Reel[] }>(overview).data?.recent[0].saved).toBe(true);
    expect(saved(other)).toBe(false);
    expect(getResourceSnapshot<PageResult<Reel>>(list).data?.items[1].saved).toBe(false);
    expect(await saveReel('a', reel)).toBe(false);
    expect(requests.filter(item => item.options.method === 'POST')).toHaveLength(1);
    const write = requests.find(item => item.options.method === 'POST')!;
    expect(write.options).toMatchObject({ credentials: 'same-origin', body: JSON.stringify({ reel_id: reel.id }) });
    write.resolve(response({ saved: true }));
    expect(await saving).toBe(true);
    expect(saved()).toBe(true);
    await flush();
    for (const path of [list, detail, overview]) {
      expect(requests.filter(request => request.path === path && !request.options.method)).toHaveLength(2);
    }
    expect(requests.filter(request => request.path === other)).toHaveLength(1);
    expect(requests.filter(request => !request.options.method).every(request => !request.options.signal?.aborted)).toBe(true);
  });

  it('does not optimistically touch or refetch creator/status/transcript views when bookmarks settle', async () => {
    const requests = setup();
    const unrelated = ['/api/workspaces/a/creators', '/api/workspaces/a/collection-status', `/api/workspaces/a/reels/${reel.id}/transcript`];
    await seed(requests, [list, detail, overview, ...unrelated]);
    const snapshots = unrelated.map(path => getResourceSnapshot(path));
    const saving = saveReel('a', reel);
    unrelated.forEach((path, index) => expect(getResourceSnapshot(path)).toBe(snapshots[index]));
    requests.find(item => item.options.method === 'POST')!.resolve(response({ saved: true }));
    await saving; await flush();
    unrelated.forEach((path, index) => {
      expect(getResourceSnapshot(path)).toBe(snapshots[index]);
      expect(requests.filter(request => request.path === path)).toHaveLength(1);
    });
  });

  it('keeps a stale in-flight GET from reverting a pending save, then accepts fresh server state', async () => {
    const requests = setup();
    await seed(requests);
    invalidateResources(list);
    await flush();
    const oldRead = requests[1];
    const saving = saveReel('a', reel);
    oldRead.resolve(response({ items: [reel], total: 1 }));
    await flush();
    expect(saved()).toBe(true);
    requests.find(item => item.options.method === 'POST')!.resolve(response({ saved: true }));
    await saving;
    await flush();
    const fresh = requests.filter(item => !item.options.method).at(-1)!;
    fresh.resolve(response({ items: [{ ...reel, saved: true, note: 'Fresh note' }], total: 1 }));
    await flush();
    expect(getResourceSnapshot<PageResult<Reel>>(list).data?.items[0]).toMatchObject({ saved: true, note: 'Fresh note' });
  });

  it('rolls back a rejected write without reverting another Reel save in flight', async () => {
    const requests = setup();
    await seed(requests);
    const first = saveReel('a', reel);
    const second = saveReel('a', otherReel);
    const failed = expect(first).rejects.toThrow('Could not save');
    requests.find(item => item.options.body === JSON.stringify({ reel_id: reel.id }))!.resolve(response({ error: { message: 'Could not save' } }, 500));
    await failed;
    expect(getResourceSnapshot<PageResult<Reel>>(list).data?.items.map(item => item.saved)).toEqual([false, true]);
    requests.find(item => item.options.body === JSON.stringify({ reel_id: otherReel.id }))!.resolve(response({ saved: true }));
    await second;
    expect(getResourceSnapshot<PageResult<Reel>>(list).data?.items.map(item => item.saved)).toEqual([false, true]);
  });

  it('preserves the visible saved-only row during an unsave and refreshes membership and totals after success', async () => {
    const requests = setup();
    const path = '/api/workspaces/a/reels?saved=true';
    cleanups.push(subscribeResource(path, () => {}));
    await flush();
    requests[0].resolve(response({ items: [{ ...reel, saved: true }], total: 1 }));
    await flush();
    const saving = saveReel('a', { ...reel, saved: true });
    expect(saved(path)).toBe(false);
    const write = requests.find(item => item.options.method === 'DELETE')!;
    expect(write.path).toBe(`/api/workspaces/a/saved/${reel.id}`);
    write.resolve(new Response(null, { status: 204 }));
    await saving;
    await flush();
    requests.filter(item => !item.options.method).at(-1)!.resolve(response({ items: [], total: 0 }));
    await flush();
    expect(getResourceSnapshot(path).data).toEqual({ items: [], total: 0 });
  });

  it('clears owner state without a late mutation restoring it or blocking the next account', async () => {
    const requests = setup();
    await seed(requests);
    const oldSave = saveReel('a', reel);
    clearResourceCache();
    expect(getResourceSnapshot(list).data).toBeNull();
    const nextSave = saveReel('a', reel);
    const writes = requests.filter(item => item.options.method === 'POST');
    expect(writes).toHaveLength(2);
    writes[0].resolve(response({ saved: true }));
    expect(await oldSave).toBe(false);
    expect(getResourceSnapshot(list).data).toBeNull();
    writes[1].resolve(response({ saved: true }));
    expect(await nextSave).toBe(true);
    expect(getResourceSnapshot(list).data).toBeNull();
  });
});
