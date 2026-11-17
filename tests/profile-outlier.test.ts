import { describe, expect, it } from 'vitest';
import { profileOutlier, withProfileOutliers } from '../src/lib/metrics';
import { createDemoData } from '../src/lib/demo';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { safeReel } from '../src/lib/server/public-data';
import { exportReelsCsv } from '../src/lib/server/csv';
import { parseReelFilterParams, reelQueryString, validateReelFilterQuery } from '../src/lib/reel-filters';

describe('profile outlier arithmetic', () => {
  it.each([[2500, .5], [5000, 1], [20000, 4], [50000, 10], [100000, 20]])('scores %i views as %sx against 5,000 typical views', (views, score) => {
    expect(profileOutlier(views, Array(30).fill(5000))).toEqual({ profile_outlier_score: score, profile_baseline_views: 5000, profile_baseline_sample: 30 });
  });
  it('uses a median robust to viral comparisons and caps the newest known sample at 30', () => {
    expect(profileOutlier(20000, [...Array(29).fill(5000), 1_000_000, ...Array(50).fill(100)]).profile_outlier_score).toBe(4);
    expect(profileOutlier(4000, [...Array(5).fill(1000), ...Array(5).fill(3000)])).toMatchObject({ profile_outlier_score: 2, profile_baseline_views: 2000 });
  });
  it('retains known zeroes and distinguishes zero baseline from missing history', () => {
    expect(profileOutlier(100, Array(9).fill(5000))).toMatchObject({ profile_outlier_score: null, profile_baseline_views: null, profile_baseline_sample: 9 });
    expect(profileOutlier(100, Array(10).fill(0))).toMatchObject({ profile_outlier_score: null, profile_baseline_views: 0, profile_baseline_sample: 10 });
    expect(profileOutlier(0, Array(10).fill(5000)).profile_outlier_score).toBe(0);
    expect(profileOutlier(5000, [null, NaN, -1, Infinity, ...Array(10).fill(5000)])).toMatchObject({ profile_outlier_score: 1, profile_baseline_sample: 10 });
    expect(profileOutlier(null, Array(30).fill(5000)).profile_outlier_score).toBeNull();
  });
  it('compares only the same profile and strictly earlier dated, known-view Reels', () => {
    const base = createDemoData().reels[0];
    const current = { ...base, id: 'current', published_at: '2026-11-01T00:00:00Z', latest_views: 20000 };
    const history = Array.from({ length: 10 }, (_, i) => ({ ...base, id: `history-${i}`, published_at: `2026-10-${String(i+1).padStart(2, '0')}T00:00:00Z`, latest_views: 5000 }));
    const excluded = [
      { ...current, id: 'same-time', latest_views: 1_000_000 },
      { ...current, id: 'future', published_at: '2026-11-02T00:00:00Z' },
      { ...history[0], id: 'foreign', creator_id: 'other' },
      { ...history[0], id: 'hidden', views_state: 'hidden' as const },
      { ...history[0], id: 'undated', published_at: null },
    ];
    const result = withProfileOutliers([current, ...excluded, ...history]);
    expect(result[0]).toMatchObject({ profile_outlier_score: 4, profile_baseline_sample: 10 });
    expect(result.find(r => r.id === 'undated')).toMatchObject({ profile_outlier_score: null, profile_baseline_sample: 0 });
    expect(current).not.toHaveProperty('profile_baseline_sample', 10);
  });
});

describe('profile filter contracts and demo reads', () => {
  it('round-trips independent profile/follower filters and rejects invalid bounds', () => {
    const query = { min_outlier: 2, min_profile_outlier: 3.25, max_profile_outlier: 500, sort: 'profile_outlier' as const };
    expect(parseReelFilterParams(new URLSearchParams(reelQueryString(query)))).toEqual(query);
    expect(validateReelFilterQuery(query)).toEqual(query);
    for (const invalid of [{ min_profile_outlier: -1 }, { max_profile_outlier: 1_000_001 }, { min_profile_outlier: Infinity }, { min_profile_outlier: 5, max_profile_outlier: 4 }, { min_profile_outlier: '3' }]) expect(() => validateReelFilterQuery(invalid)).toThrow();
  });
  it('keeps the same score through filtering, pagination, detail, export and saved presets', async () => {
    const repo = new DemoRepository(), workspace = (await repo.bootstrap()).workspaces[0].id;
    const query = { min_profile_outlier: 0, sort: 'profile_outlier' as const };
    const page = await repo.reels(workspace, query), reel = page.items[0];
    expect(page.total).toBeGreaterThan(1);
    expect(page.items.every(r => r.profile_outlier_score !== null)).toBe(true);
    expect(page.items.map(r => r.profile_outlier_score)).toEqual(page.items.map(r => r.profile_outlier_score).sort((a,b) => b! - a!));
    expect((await repo.reels(workspace, { ...query, creator_id: reel.creator_id, keywords: reel.caption_preview, limit: 1 })).items[0]).toEqual(reel);
    expect((await repo.reelDetail(workspace, reel.id)).reel.profile_outlier_score).toBe(reel.profile_outlier_score);
    expect(await repo.reelNeighbors(workspace, reel.id, query)).toMatchObject({ position: 1, next_id: page.items[1].id, total: page.total });
    const saved = await repo.createReelFilter(`Profile ${Date.now()}`, query);
    try { expect(saved.config.query).toEqual(query); } finally { await repo.deleteReelFilter(saved.id); }
    const csv = exportReelsCsv([safeReel(reel)]).split('\r\n');
    expect(csv[0]).toContain('"profile_outlier_score","profile_baseline_views","profile_baseline_sample"');
    expect(csv[1]).toContain(`,"${reel.profile_outlier_score}","${reel.profile_baseline_views}","${reel.profile_baseline_sample}"`);
  });
  it('never exposes an invalid or unsupported score from the public boundary', () => {
    const reel = { ...createDemoData().reels[0], profile_outlier_score: 4, profile_baseline_views: 5000, profile_baseline_sample: 30 };
    expect(safeReel(reel).profile_outlier_score).toBe(4);
    for (const patch of [{ views_state: 'hidden' as const }, { published_at: null }, { profile_baseline_sample: 9 }, { profile_baseline_views: 0 }, { profile_outlier_score: Infinity }]) expect(safeReel({ ...reel, ...patch }).profile_outlier_score).toBeNull();
  });
});
