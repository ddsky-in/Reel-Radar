import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureStranger } from './support/feature-database';
import { withProfileOutliers } from '../src/lib/metrics';
import type { PageResult, Reel, ReelDetail, ReelNeighbors, ReelQuery, SavedReelFilter } from '../src/lib/types';

let f: Awaited<ReturnType<typeof featureDatabase>>;
beforeAll(async () => { f = await featureDatabase(); }, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); });
afterEach(async () => { await f.db.exec('rollback; reset role'); });
const page = (query: ReelQuery = {}) => f.rpc<PageResult<Reel>>('query_reels', [f.workspace, JSON.stringify(query)]);

async function seed() {
  await f.db.query(`insert into public.reels(creator_id,shortcode,caption_preview,published_at,latest_fetched_at,provider,latest_views,views_state)
    select $1,'BASE_'||n,'Baseline',timestamptz '2026-10-31 00:00Z'-make_interval(days=>n),now(),'fixture',5000,'known'
    from generate_series(1,35) n`, [f.creator]);
  await f.db.query(`insert into public.reels(creator_id,shortcode,caption_preview,published_at,latest_fetched_at,provider,latest_views,views_state)
    select $1,'TARGET_'||v,'Target',timestamptz '2026-10-31 00:00Z',now(),'fixture',v,'known'
    from unnest(array[0,20000,50000,100000]) v`, [f.creator]);
  await f.db.query("update public.reels set latest_views=1000000 where creator_id=$1 and shortcode in ('BASE_35','BASE_30')", [f.creator]);
  await f.identity('authenticated');
}

describe('profile outlier database parity and integration', () => {
  it('matches TypeScript for every Reel, caps at 30 and does not alter follower metrics', async () => {
    await seed();
    const result = await page({ limit: 50 });
    const calculated = withProfileOutliers(result.items);
    for (const reel of result.items) {
      const expected = calculated.find(r => r.id === reel.id)!;
      expect(reel.profile_outlier_score).toBe(expected.profile_outlier_score);
      expect(reel.profile_baseline_views).toBe(expected.profile_baseline_views);
      expect(reel.profile_baseline_sample).toBe(expected.profile_baseline_sample);
      expect(reel.follower_outlier_score).toBeNull();
    }
    expect(result.items.find(r => r.shortcode === 'TARGET_20000')).toMatchObject({ profile_outlier_score: 4, profile_baseline_views: 5000, profile_baseline_sample: 30 });
  });
  it('filters exact scores independently of search, saved state and pagination, including zero', async () => {
    await seed();
    const query: ReelQuery = { keywords: 'Target', min_profile_outlier: 4, max_profile_outlier: 20, sort: 'profile_outlier', limit: 1 };
    const first = await page(query), second = await page({ ...query, page: 2 });
    expect(first.total).toBe(3);
    expect(first.items[0].profile_outlier_score).toBe(20);
    expect(second.items[0].profile_outlier_score).toBe(10);
    const last = await page({ ...query, page: 3 });
    expect(last.items[0].profile_outlier_score).toBe(4);
    expect((await page({ ...query, min_profile_outlier: 4.00001 })).total).toBe(2);
    expect((await page({ max_profile_outlier: 0 })).items.map(r => r.shortcode)).toEqual(['TARGET_0']);
    expect((await page({ ...query, min_outlier: 0 })).total).toBe(0);
    await f.rpc('set_bookmark', [f.workspace, last.items[0].id, true]);
    expect((await page({ ...query, saved: true })).items[0]).toMatchObject({ profile_outlier_score: 4, profile_baseline_sample: 30 });
    const detail = await f.rpc<ReelDetail>('get_reel_detail', [f.workspace, last.items[0].id]);
    expect(detail.reel.profile_outlier_score).toBe(4);
    const neighbors = await f.rpc<ReelNeighbors>('get_reel_neighbors', [f.workspace, second.items[0].id, JSON.stringify(query)]);
    expect(neighbors).toEqual({ previous_id: first.items[0].id, next_id: last.items[0].id, position: 2, total: 3 });
    const { limit: _limit, ...presetQuery } = query; void _limit;
    const saved = await f.rpc<SavedReelFilter>('create_reel_filter', ['Profile targets', JSON.stringify(presetQuery)]);
    expect(saved.config.query).toEqual(presetQuery);
  });
  it('handles limited samples, missing metrics and zero medians without fabricating scores', async () => {
    await seed(); await f.identity();
    await f.db.query("delete from public.reels where creator_id=$1 and shortcode like 'BASE_%' and substring(shortcode from 6)::int>10", [f.creator]);
    await f.db.query("update public.reels set latest_views=0 where creator_id=$1 and shortcode like 'BASE_%'", [f.creator]);
    await f.identity('authenticated');
    expect((await page({ keywords: 'Target' })).items[0]).toMatchObject({ profile_outlier_score: null, profile_baseline_views: 0, profile_baseline_sample: 10 });
    expect((await page({ min_profile_outlier: 0 })).total).toBe(0);
    await f.identity();
    await f.db.query("update public.reels set latest_views=null,views_state='hidden' where creator_id=$1 and shortcode='BASE_1'", [f.creator]);
    await f.identity('authenticated');
    expect((await page({ keywords: 'Target' })).items[0]).toMatchObject({ profile_outlier_score: null, profile_baseline_views: null, profile_baseline_sample: 9 });
  });
  it('retains the follower formula and computes from older history even when date filters hide it', async () => {
    await seed(); await f.identity();
    await f.db.query('update public.creators set followers_count=10000 where id=$1', [f.creator]);
    await f.db.query("update public.reels set latest_likes=1000,latest_comments=100,likes_state='known',comments_state='known' where creator_id=$1 and shortcode='TARGET_20000'", [f.creator]);
    await f.identity('authenticated');
    const [reel] = (await page({ min_profile_outlier: 4, max_profile_outlier: 4, from: '2026-10-31', to: '2026-10-31' })).items;
    expect(reel).toMatchObject({ profile_outlier_score: 4, follower_outlier_score: 2.11, engagement_rate_pct: 5.5, profile_baseline_sample: 30 });
  });
  it.each([{ min_profile_outlier: -1 }, { min_profile_outlier: '4' }, { max_profile_outlier: 1000001 }, { min_profile_outlier: 5, max_profile_outlier: 4 }])('rejects invalid profile filters %j', async query => {
    await f.identity('authenticated');
    await expect(f.rpc('query_reels', [f.workspace, JSON.stringify(query)])).rejects.toMatchObject({ code: '22023' });
  });
  it('preserves invoker view security and rejects foreign workspaces before counts or scores', async () => {
    await seed(); const id = (await page()).items[0].id;
    await f.identity();
    expect(await f.value<string[]>("select reloptions v from pg_class where oid='public.reels_summary'::regclass")).toContain('security_invoker=true');
    await f.identity('authenticated', fixtureStranger);
    for (const read of [() => page({ sort: 'profile_outlier' }), () => f.rpc('get_reel_detail', [f.workspace, id]), () => f.rpc('get_reel_neighbors', [f.workspace, id, '{"min_profile_outlier":0}'])]) {
      await f.db.exec('savepoint denied_read');
      await expect(read()).rejects.toThrow(/forbidden/);
      await f.db.exec('rollback to savepoint denied_read');
    }
    expect(await f.value<number>('select count(*)::int v from public.reels_summary')).toBe(0);
  });
});
