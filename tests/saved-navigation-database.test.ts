import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureStranger } from './support/feature-database';
import type { PageResult, Reel, ReelDetail, ReelNeighbors, ReelQuery } from '../src/lib/types';

let f: Awaited<ReturnType<typeof featureDatabase>>;
beforeAll(async () => { f = await featureDatabase(); }, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); });
afterEach(async () => { await f.db.exec('rollback; reset role'); });
const page = (query: ReelQuery = {}, workspace = f.workspace) => f.rpc<PageResult<Reel>>('query_reels', [workspace, JSON.stringify(query)]);
const neighbors = (id: string, query: ReelQuery = {}, workspace = f.workspace) => f.rpc<ReelNeighbors>('get_reel_neighbors', [workspace, id, JSON.stringify(query)]);

describe('saved Reel completion persistence and access', () => {
  it('persists Done in detail and list reads, preserves notes/tags, and supports Pending again', async () => {
    const id = await f.reel(); await f.identity('authenticated');
    await f.rpc('set_bookmark', [f.workspace, id, true, 'Original', ['hook']]);
    await f.rpc('set_saved_reel_completion', [f.workspace, id, 'done']);
    expect((await page({ saved: true })).items[0]).toMatchObject({ id, saved: true, completion_status: 'done' });
    await f.rpc('set_bookmark', [f.workspace, id, true, 'Edited', ['remake']]);
    await f.identity(); const first = await f.value<string>('select completed_at::text v from public.saved_reels where reel_id=$1', [id]);
    await f.identity('authenticated'); await f.rpc('set_saved_reel_completion', [f.workspace, id, 'done']);
    expect((await f.rpc<ReelDetail>('get_reel_detail', [f.workspace, id])).reel).toMatchObject({ completion_status: 'done', note: 'Edited', tags: ['remake'] });
    await f.identity(); expect(await f.value<string>('select completed_at::text v from public.saved_reels where reel_id=$1', [id])).toBe(first);
    await f.identity('authenticated'); await f.rpc('set_saved_reel_completion', [f.workspace, id, 'pending']);
    expect((await page()).items[0].completion_status).toBe('pending');
    await f.identity(); expect(await f.value('select completed_at v from public.saved_reels where reel_id=$1', [id])).toBeNull();
  });
  it('keeps completion independent between workspaces sharing the same Reel', async () => {
    const id = await f.reel(); await f.identity('authenticated');
    const { id: second } = await f.rpc<{ id: string }>('create_workspace', ['Second research']);
    await f.rpc('add_creator', [second, 'backend_fixture']);
    for (const workspace of [f.workspace, second]) await f.rpc('set_bookmark', [workspace, id, true]);
    await f.rpc('set_saved_reel_completion', [f.workspace, id, 'done']);
    expect((await page({}, second)).items[0].completion_status).toBe('pending');
    expect((await page()).items[0].completion_status).toBe('done');
  });
  it.each(['unsaved', 'detached', 'archived', 'foreign'] as const)('rejects completion and avoids leakage for %s access', async state => {
    const id = await f.reel(); await f.identity('authenticated');
    if (state !== 'unsaved') await f.rpc('set_bookmark', [f.workspace, id, true]);
    await f.identity();
    if (state === 'detached') await f.db.query('update public.workspace_creators set active=false where workspace_id=$1', [f.workspace]);
    if (state === 'archived') await f.db.query('update public.workspaces set archived_at=now() where id=$1', [f.workspace]);
    await f.identity('authenticated', state === 'foreign' ? fixtureStranger : undefined);
    await expect(f.rpc('set_saved_reel_completion', [f.workspace, id, 'done'])).rejects.toThrow(/forbidden|workspace|saved/);
  });
});

async function seedList() {
  await f.db.query('update public.creators set followers_count=1000 where id=$1', [f.creator]);
  await f.db.query(`insert into public.reels(creator_id,shortcode,caption_preview,published_at,latest_fetched_at,provider,
    latest_views,latest_likes,latest_comments,views_state,likes_state,comments_state)
    select $1,'NAV_'||n,case when n%2=0 then 'Hook launch' else 'Another caption' end,
      now()-make_interval(days=>n),now()-make_interval(hours=>n),'fixture',1000+n*10,100-n,n%9,'known','known','known'
    from generate_series(1,64) n`, [f.creator]);
  await f.identity('authenticated');
}

describe('navigation follows the complete filtered order', () => {
  it.each(['published_at', 'views', 'likes', 'comments', 'engagement', 'outlier', 'profile_outlier'] as const)('matches %s pagination, including first/last and a page boundary', async sort => {
    await seedList();
    const first = await page({ sort, limit: 30 }), second = await page({ sort, page: 2, limit: 30 });
    const final = await page({ sort, page: 3, limit: 30 });
    expect(first.total).toBe(64);
    expect(await neighbors(first.items[29].id, { sort, page: 1, limit: 30 })).toEqual({ previous_id: first.items[28].id, next_id: second.items[0].id, position: 30, total: 64 });
    expect(await neighbors(first.items[0].id, { sort })).toMatchObject({ previous_id: null, next_id: first.items[1].id, position: 1 });
    expect(await neighbors(final.items.at(-1)!.id, { sort })).toMatchObject({ next_id: null, position: 64 });
  });
  it('uses identical search, creator, numeric, freshness, platform and saved filters for lists and neighbors', async () => {
    await seedList();
    const all = [...(await page({ limit: 50 })).items, ...(await page({ limit: 50, page: 2 })).items];
    for (const reel of all.filter((_, i) => i%3 === 0)) await f.rpc('set_bookmark', [f.workspace, reel.id, true]);
    const filters: ReelQuery[] = [
      { keywords: 'Hook', sort: 'views' }, { search: 'caption', sort: 'comments' },
      { creator_ids: [f.creator], min_views: 1100, max_views: 1300, min_engagement: 0, max_engagement: 20, min_outlier: 0, max_outlier: 2 },
      { freshness: 'stale', platform: 'instagram' }, { saved: true, sort: 'likes' },
    ];
    for (const query of filters) {
      const result = await page({ ...query, limit: 50 });
      expect(result.total).toBeGreaterThan(2);
      const middle = Math.floor(result.items.length/2);
      expect(await neighbors(result.items[middle].id, query)).toEqual({ previous_id: result.items[middle-1].id, next_id: result.items[middle+1].id, position: middle+1, total: result.total });
    }
  });
  it('returns no arbitrary neighbor when the current Reel is removed from the saved filter', async () => {
    await seedList(); const [first, second] = (await page()).items;
    for (const reel of [first, second]) await f.rpc('set_bookmark', [f.workspace, reel.id, true]);
    await f.rpc('set_bookmark', [f.workspace, first.id, false]);
    expect(await neighbors(first.id, { saved: true })).toEqual({ previous_id: null, next_id: null, position: null, total: 1 });
  });
  it('rejects foreign-workspace navigation before returning list counts', async () => {
    await seedList(); const id = (await page()).items[0].id;
    await f.identity('authenticated', fixtureStranger);
    await expect(neighbors(id)).rejects.toThrow(/forbidden/);
  });
});
