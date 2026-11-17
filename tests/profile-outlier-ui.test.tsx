import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfileOutlierValue } from '../src/components/profile-outlier';
import { ReelCard, ReelTable } from '../src/components/reels';
import { ReelFilters, activeFilterItems, clearFilterCriteria, removeFilterCriteria } from '../src/components/reel-filters';
import { createDemoData } from '../src/lib/demo';

const reel = { ...createDemoData().reels[0], latest_views: 20000, profile_outlier_score: 4, profile_baseline_views: 5000, profile_baseline_sample: 30 };

describe('profile outlier presentation', () => {
  it('shows a distinct score and explains the baseline on both cards and table rows', () => {
    for (const node of [<ReelCard key="card" reel={reel} workspaceId="workspace" onSave={() => {}}/>, <ReelTable key="table" reels={[reel]} workspaceId="workspace" onSave={() => {}}/>]) {
      const html = renderToStaticMarkup(node);
      expect(html).toContain('Follower outlier'); expect(html).toContain('Profile outlier');
      expect(html).toContain('4.0x'); expect(html).toContain('Profile typical: 5,000 views');
      expect(html).toContain('Median of 30 earlier Reels');
    }
  });
  it('shows limited and insufficient samples separately from zero or missing views', () => {
    expect(renderToStaticMarkup(<ProfileOutlierValue reel={{ ...reel, profile_baseline_sample: 10 }}/>)).toContain('Limited sample');
    expect(renderToStaticMarkup(<ProfileOutlierValue reel={{ ...reel, profile_baseline_sample: 9, profile_outlier_score: null, profile_baseline_views: null }}/>)).toContain('Insufficient data');
    expect(renderToStaticMarkup(<ProfileOutlierValue reel={{ ...reel, profile_baseline_views: 0, profile_outlier_score: null }}/>)).toContain('Zero baseline');
    expect(renderToStaticMarkup(<ProfileOutlierValue reel={{ ...reel, latest_views: null, views_state: 'hidden', profile_outlier_score: null }}/>)).toContain('Views unavailable');
  });
  it('keeps new filters opt-in and independently removable from follower filters', () => {
    const html = renderToStaticMarkup(<ReelFilters workspaceId="workspace" value={{}} onChange={() => {}} notify={() => {}} layout="sidebar"/>);
    for (const bound of ['Minimum', 'Maximum']) expect(html).toMatch(new RegExp(`aria-label="${bound} Profile Outlier Score"[^>]*value=""`));
    const query = { min_outlier: 2, min_profile_outlier: 3, max_profile_outlier: 20, sort: 'profile_outlier' as const };
    const item = activeFilterItems(query).find(item => item.id === 'Profile Outlier Score')!;
    expect(item.label).toBe('Profile Outlier Score: 3x–20x');
    expect(removeFilterCriteria(query, item.keys)).toMatchObject({ min_outlier: 2, min_profile_outlier: undefined, max_profile_outlier: undefined });
    expect(clearFilterCriteria(query)).toEqual({ sort: 'profile_outlier', limit: undefined, page: 1 });
  });
});
