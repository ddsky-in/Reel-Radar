import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DELETE } from '../src/app/api/[...path]/route';
import type { BulkRemoveCreatorsResult } from '../src/lib/types';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import { removeCreators } from '../src/lib/server/remove-creators';
import { ApiError } from '../src/lib/server/errors';

const origin = 'http://127.0.0.1:3100';
const missingId = '00000000-0000-4000-8000-000000000099';
let testTime = Date.now();

function remove(workspaceId: string, body: unknown, requestOrigin: string | null = origin, query = '') {
  const path = ['workspaces', workspaceId, 'creators'];
  return DELETE(new Request(`${origin}/api/${path.join('/')}${query}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...(requestOrigin === null ? {} : { origin: requestOrigin }) },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ path }) });
}

beforeEach(() => {
  // Isolate each API case from the process-wide request-limit window.
  testTime += 61_000;
  vi.spyOn(Date, 'now').mockReturnValue(testTime);
  vi.stubGlobal('__reelradarDemo', undefined);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('ALLOW_LOCAL_DEMO', 'true');
  vi.stubEnv('SCRAPING_ENABLED', 'false');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', origin);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External provider calls forbidden'));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('bulk competitor deletion API', () => {
  it('removes only selected workspace links and bookmarks while preserving shared research', async () => {
    const repo = new DemoRepository();
    const source = (await repo.bootstrap()).workspaces[0];
    const before = await repo.creators(source.id);
    const selected = before.slice(0, 2);
    const target = await repo.createWorkspace('Shared deletion research');
    for (const creator of selected) await repo.addCreator(target.id, creator.username);
    const sharedReels = await repo.reels(target.id, {});
    expect(sharedReels.total).toBeGreaterThan(0);
    const reel = sharedReels.items[0];
    await repo.save(source.id, reel.id, 'Selected workspace note', []);
    await repo.save(target.id, reel.id, 'Preserve this other workspace note', []);
    const removeCreator = vi.spyOn(DemoRepository.prototype, 'removeCreator');

    const response = await remove(source.id, { creator_ids: [selected[0].id, selected[1].id, selected[0].id] });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(await response.json()).toEqual({ removed_ids: selected.map(creator => creator.id), already_removed_ids: [], failed: [] });
    expect(removeCreator).toHaveBeenCalledTimes(2);
    expect(await repo.creators(source.id)).toEqual(before.slice(2));
    expect((await repo.reels(source.id, { saved: true })).items.some(item => item.id === reel.id)).toBe(false);
    expect((await repo.reels(target.id, {})).total).toBe(sharedReels.total);
    expect((await repo.reels(target.id, { saved: true })).items.find(item => item.id === reel.id)?.note).toBe('Preserve this other workspace note');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('deletes more than 80 competitors through one mutation request', async () => {
    const repo = new DemoRepository();
    const target = await repo.createWorkspace('Large deletion');
    await repo.importCreators(target.id, 'username\n' + Array.from({ length: 90 }, (_, index) => `bulk_delete_${index}`).join('\n'), false);
    const ids = (await repo.creators(target.id)).map(creator => creator.id);
    expect(ids).toHaveLength(90);
    const response = await remove(target.id, { creator_ids: ids });
    expect(response.status).toBe(200);
    expect((await response.json() as BulkRemoveCreatorsResult).removed_ids).toHaveLength(90);
    expect(await repo.creators(target.id)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates the entire request before deleting anything', async () => {
    const repo = new DemoRepository();
    const workspace = (await repo.bootstrap()).workspaces[0];
    const before = await repo.creators(workspace.id);
    for (const body of [
      {}, { creator_ids: [] }, { creator_ids: [before[0].id, 'invalid'] },
      { creator_ids: [before[0].id], workspace_id: missingId },
      { creator_ids: Array.from({ length: 1001 }, () => before[0].id) },
    ]) expect((await remove(workspace.id, body)).status).toBe(400);
    expect((await remove(workspace.id, { creator_ids: [before[0].id] }, origin, '?owner=other')).status).toBe(400);
    expect((await remove(workspace.id, { creator_ids: [before[0].id], excess: 'x'.repeat(45_000) })).status).toBe(413);
    expect(await repo.creators(workspace.id)).toEqual(before);
  });

  it('rejects foreign or missing origins, missing workspaces, and archived workspaces', async () => {
    const repo = new DemoRepository();
    const workspace = (await repo.bootstrap()).workspaces[0];
    const before = await repo.creators(workspace.id);
    const body = { creator_ids: before.slice(0, 2).map(creator => creator.id) };
    for (const requestOrigin of [null, 'https://foreign.example']) expect((await remove(workspace.id, body, requestOrigin)).status).toBe(403);
    expect((await remove(missingId, body)).status).toBe(404);
    await repo.updateWorkspace(workspace.id, { archived: true });
    expect((await remove(workspace.id, body)).status).toBe(409);
    await repo.updateWorkspace(workspace.id, { archived: false });
    expect(await repo.creators(workspace.id)).toEqual(before);
  });

  it('reports partial failures safely and retries without deleting completed selections twice', async () => {
    const repo = new DemoRepository();
    const workspace = (await repo.bootstrap()).workspaces[0];
    const selected = (await repo.creators(workspace.id)).slice(0, 3);
    const original = DemoRepository.prototype.removeCreator;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = vi.spyOn(DemoRepository.prototype, 'removeCreator').mockImplementation(function(this: DemoRepository, id, creatorId) {
      if (creatorId === selected[1].id) throw new Error('private database credential');
      return original.call(this, id, creatorId);
    });
    const body = { creator_ids: selected.map(creator => creator.id) };
    const first = await remove(workspace.id, body);
    expect(first.status).toBe(200);
    const result: BulkRemoveCreatorsResult = await first.json();
    expect(result.removed_ids).toEqual([selected[0].id, selected[2].id]);
    expect(result.failed).toEqual([{ creator_id: selected[1].id, error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } }]);
    expect(JSON.stringify(result)).not.toContain('private database credential');
    expect((await repo.creators(workspace.id)).some(creator => creator.id === selected[1].id)).toBe(true);
    expect(log).toHaveBeenCalled();
    failure.mockRestore();

    const retry = vi.spyOn(DemoRepository.prototype, 'removeCreator');
    const second = await remove(workspace.id, body);
    expect(await second.json()).toEqual({ removed_ids: [selected[1].id], already_removed_ids: [selected[0].id, selected[2].id], failed: [] });
    expect(retry).toHaveBeenCalledOnce();
    expect((await repo.creators(workspace.id)).some(creator => body.creator_ids.includes(creator.id))).toBe(false);
  });

  it('leaves accounts outside the selected workspace intact and treats missing links as already removed', async () => {
    const repo = new DemoRepository();
    const source = (await repo.bootstrap()).workspaces[0];
    const existing = await repo.creators(source.id);
    const target = await repo.createWorkspace('Empty deletion destination');
    const removeCreator = vi.spyOn(DemoRepository.prototype, 'removeCreator');
    const ids = [existing[0].id, missingId];
    const response = await remove(target.id, { creator_ids: ids });
    expect(await response.json()).toEqual({ removed_ids: [], already_removed_ids: ids, failed: [] });
    expect(removeCreator).not.toHaveBeenCalled();
    expect(await repo.creators(source.id)).toEqual(existing);
  });

  it('fails closed without production Supabase and owner configuration', async () => {
    vi.stubEnv('DEMO_MODE', 'false');
    for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'OWNER_EMAIL', 'OWNER_USER_ID']) vi.stubEnv(name, '');
    const response = await remove(missingId, { creator_ids: [missingId] });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'CONFIG_REQUIRED' } });
  });

  it('refuses Supabase deletion before data reads or RPCs when workspace membership is absent', async () => {
    const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    const client = { from: vi.fn().mockReturnValue(chain), rpc: vi.fn() };
    const repo = new SupabaseRepository(client as unknown as SupabaseClient, 'owner', 'owner@example.test');
    await expect(removeCreators(repo, missingId, [missingId])).rejects.toBeInstanceOf(ApiError);
    expect(client.from).toHaveBeenCalledWith('workspace_members');
    expect(client.from).not.toHaveBeenCalledWith('workspaces');
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
