import { afterEach, describe, expect, it } from 'vitest';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { completionSchema, validate } from '../src/lib/server/validation';
import { reelDetailPath, reelListQuery } from '../src/lib/app-navigation';

afterEach(() => { delete (globalThis as typeof globalThis & { __reelradarDemo?: unknown }).__reelradarDemo; });
describe('completion and navigation application contracts', () => {
  it('preserves saved completion across repository instances and annotation edits', async () => {
    const repo = new DemoRepository(); const workspace = (await repo.bootstrap()).workspaces[0].id;
    const reel = (await repo.reels(workspace, {})).items[0];
    await repo.save(workspace, reel.id, '', []); await repo.setCompletion(workspace, reel.id, 'done');
    const reopened = new DemoRepository(); await reopened.save(workspace, reel.id, 'Edited note', ['hook']);
    expect((await reopened.reelDetail(workspace, reel.id)).reel).toMatchObject({ saved: true, completion_status: 'done', note: 'Edited note' });
    await reopened.setCompletion(workspace, reel.id, 'pending');
    expect((await repo.reelDetail(workspace, reel.id)).reel.completion_status).toBe('pending');
  });
  it('keeps demo navigation aligned with filtered pagination', async () => {
    const repo = new DemoRepository(); const workspace = (await repo.bootstrap()).workspaces[0].id;
    const query = { sort: 'views' as const, min_views: 100, limit: 2 };
    const first = await repo.reels(workspace, query), second = await repo.reels(workspace, { ...query, page: 2 });
    expect(await repo.reelNeighbors(workspace, first.items[1].id, query)).toEqual({ previous_id: first.items[0].id, next_id: second.items[0].id, position: 2, total: first.total });
  });
  it('only accepts Pending and Done, without allowing owner or workspace overrides', () => {
    for (const value of [{}, { completion_status: 'finished' }, { completion_status: 'done', owner_user_id: 'foreign' }]) expect(() => validate(completionSchema, value)).toThrow();
    expect(validate(completionSchema, { completion_status: 'done' })).toEqual({ completion_status: 'done' });
  });
  it('carries the current filter/sort across detail links and drops pagination from neighbor context', () => {
    const link = new URL(reelDetailPath('fixture', 'workspace', '/saved?sort=views', { keywords: 'AI tools', min_views: 1000, sort: 'outlier', page: 3, limit: 30 }), 'http://localhost');
    expect(reelListQuery(link.searchParams.get('list'), link.searchParams.get('returnTo'))).toMatchObject({ saved: true, keywords: 'AI tools', min_views: 1000, sort: 'outlier', page: undefined, limit: undefined });
    expect(link.searchParams.get('list')).not.toMatch(/page|limit/);
  });
});
