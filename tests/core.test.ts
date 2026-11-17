import { describe, expect, it } from 'vitest';
import { engagementRate, followerOutlier, isStale, normalizeMetric, qualifiesEngagement, qualifiesOutlier, relativePerformance } from '../src/lib/metrics';
import { normalizeHandle, canonicalReelUrl } from '../src/lib/normalize';
import { formatScore } from '../src/lib/format';
import { createDemoData } from '../src/lib/demo';

describe('Instagram normalization', () => {
  it.each(['@Example', 'example', 'https://instagram.com/Example/reels/?igsh=foo', 'instagram.com/Example'])('normalizes %s', input => expect(normalizeHandle(input)).toBe('example'));
  it.each(['https://evil.test/example', 'instagram.com/reel/abc', 'instagram.com/example/other', '@bad..handle', 'https://instagram.com@evil.test/example', '', 'a'.repeat(31)])('rejects %s', input => expect(() => normalizeHandle(input)).toThrow());
  it('canonicalizes original Reel links and rejects unsafe sources', () => {
    expect(canonicalReelUrl('https://instagram.com/reel/ABC123/?igsh=foo')).toEqual({ shortcode: 'ABC123', url: 'https://www.instagram.com/reel/ABC123/' });
    expect(canonicalReelUrl('https://evil.test/reel/ABC123')).toBeNull();
    expect(canonicalReelUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('metrics are calculated from known values, never invented zeroes', () => {
  it('matches PRD formulas', () => {
    expect(followerOutlier(1_000_000, 20_000, 500, 100_000)).toBe(10.205);
    expect(formatScore(10.205)).toBe('10.2x');
    expect(engagementRate(1_000_000, 20_000, 500)).toBe(2.05);
  });
  it('qualifies equality and uses unrounded thresholds', () => {
    expect(qualifiesEngagement(5)).toBe(true); expect(qualifiesOutlier(5)).toBe(true);
    expect(qualifiesEngagement(4.999)).toBe(false); expect(qualifiesOutlier(4.999)).toBe(false);
    expect(qualifiesEngagement(null)).toBe(false); expect(qualifiesOutlier(NaN)).toBe(false);
  });
  it.each([null, -1, NaN, Infinity])('nullifies missing and invalid likes %s', likes => {
    expect(engagementRate(100, likes, 1)).toBeNull(); expect(followerOutlier(100, likes, 1, 10)).toBeNull();
  });
  it('distinguishes valid zero from missing and zero denominators', () => {
    expect(normalizeMetric(0)).toBe(0); expect(normalizeMetric('100')).toBeNull();
    expect(engagementRate(100, 0, 0)).toBe(0); expect(engagementRate(0, 0, 0)).toBeNull();
    expect(followerOutlier(0, 0, 0, 10)).toBe(0); expect(followerOutlier(1, 0, 0, 0)).toBeNull();
    expect(followerOutlier(1, 0, null, 10)).toBeNull();
  });
  it('requires 10 comparisons for secondary score and reports estimate', () => {
    expect(relativePerformance(100, [10, 20]).score).toBeNull();
    expect(relativePerformance(100, Array(10).fill(20))).toEqual({ score: 5, sample: 10, estimated: true });
    expect(relativePerformance(100, Array(30).fill(20)).estimated).toBe(false);
  });
  it('uses strictly greater than 48 hours for stale', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    expect(isStale('2026-11-06T12:00:00Z', now)).toBe(false);
    expect(isStale('2026-11-06T11:59:59Z', now)).toBe(true);
    expect(isStale(null, now)).toBe(true);
  });
});

describe('demo fixtures are honest and canonical', () => {
  it('uses unique profiles and media shared by workspace mappings', () => {
    const data = createDemoData();
    expect(new Set(data.creators.map(c => c.username)).size).toBe(data.creators.length);
    expect(new Set(data.reels.map(r => r.id)).size).toBe(data.reels.length);
    expect(data.workspaceCreators.filter(m => m.creator_id === data.creators[0].id)).toHaveLength(2);
    expect(data.reels.every(r => r.provider === 'mock' && r.reel_url === null)).toBe(true);
    expect(data.jobs.every(j => j.actor_run_id === null && j.actual_cost_usd === null)).toBe(true);
    expect(data.settings.scraping_enabled).toBe(false);
  });
});
