import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReelFilters, filterScope } from '../src/components/reel-filters';
import { defaultReelFilters } from '../src/lib/reel-filters';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('shared functional advanced filter presentation', () => {
  it('renders the research controls without the obsolete platform filter', () => {
    const html = renderToStaticMarkup(<ReelFilters workspaceId="workspace" value={defaultReelFilters()} onChange={() => {}} notify={() => {}}/>);
    for (const label of ['Channels','Outlier Score','Views','Engagement','Posted In Last','Keywords','Saved Filters','Show','Clear','Save Filter','e.g. AI tutorial']) expect(html).toContain(label);
    expect(html).not.toContain('All Platforms');
    expect(html).not.toContain('aria-label="Platform"');
    expect(html).not.toContain('TikTok');
    expect(html).not.toContain('YouTube');
    expect(html).not.toContain('value="9"');
    expect(html).toContain('value=""');
    expect(html).toContain('value="" selected="">Select unit');
    expect(html).not.toContain('aria-pressed="true"');
    const numericInputs = html.match(/<input\b[^>]*type="number"[^>]*>/g) ?? [];
    expect(numericInputs).toHaveLength(9);
    for (const input of numericInputs) expect(input).toContain('value=""');
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).toContain('aria-label="Minimum Outlier Score"');
    expect(html).toContain('aria-label="Maximum Views"');
    expect(html).toContain('aria-label="Minimum Engagement"');
  });
  it('uses one shared filter component across Explorer and creator detail', () => {
    for (const component of ['explorer','competitors']) expect(source(`src/components/${component}.tsx`)).toContain('<ReelFilters');
    expect(source('src/components/explorer.tsx')).toContain('reelQueryString(query)');
    expect(source('src/components/competitors.tsx')).toContain('creator_id: creator.id');
  });
  it('keeps mandatory bookmark and creator scopes without restoring hidden outlier defaults', () => {
    expect(filterScope({ saved:false,min_outlier:1,creator_id:'other' },{savedOnly:true,creatorId:'locked'})).toMatchObject({saved:true,min_outlier:1,creator_id:'locked'});
    expect(filterScope({creator_ids:['other']},{creatorId:'locked'})).toMatchObject({creator_ids:['other'],creator_id:'locked'});
    expect(filterScope({ platform: 'instagram', min_views: 100 }, {})).toEqual({ min_views: 100 });
  });
  it('renders blank and one-sided range endpoints without making empty fields invalid', () => {
    for (const value of [{}, { min_views: 0 }, { max_views: 125 }, { min_outlier: 1.5 }, { max_engagement: 0.5 }]) {
      const html = renderToStaticMarkup(<ReelFilters workspaceId="workspace" value={value} onChange={() => {}} notify={() => {}}/>);
      expect(html).not.toContain('aria-invalid="true"');
      for (const placeholder of ['e.g. 3', 'e.g. 20', 'e.g. 10000', 'e.g. 1000000', 'e.g. 2', 'e.g. 10', 'e.g. 7']) expect(html).toContain(`placeholder="${placeholder}"`);
      if ('min_views' in value) expect(html).toMatch(/aria-label="Minimum Views"[^>]*value="0"/);
      if ('max_views' in value) expect(html).toMatch(/aria-label="Maximum Views"[^>]*value="125"/);
      if ('min_outlier' in value) expect(html).toMatch(/aria-label="Minimum Outlier Score"[^>]*value="1.5"/);
      if ('max_engagement' in value) expect(html).toMatch(/aria-label="Maximum Engagement"[^>]*value="0.5"/);
    }
  });
  it('loads explicit saved ranges and rolling periods without adding unrelated conditions', () => {
    const html = renderToStaticMarkup(<ReelFilters workspaceId="workspace" value={{ max_views: 450, min_engagement: 1.25, posted_amount: 3, posted_unit: 'weeks' }} onChange={() => {}} notify={() => {}}/>);
    expect(html).toMatch(/aria-label="Maximum Views"[^>]*value="450"/);
    expect(html).toMatch(/aria-label="Minimum Views"[^>]*value=""/);
    expect(html).toMatch(/aria-label="Minimum Engagement"[^>]*value="1.25"/);
    expect(html).toMatch(/aria-label="Posted in last amount"[^>]*value="3"/);
    expect(html).toContain('value="weeks" selected=""');
    expect(html).not.toContain('aria-invalid="true"');
    expect(filterScope({})).toEqual({});
    expect(filterScope({ max_outlier: 2 })).toEqual({ max_outlier: 2 });
  });
  it('uses authenticated preset APIs and never scraping endpoints', () => {
    const filters = source('src/components/reel-filters.tsx');
    expect(filters).toContain("useResource<SavedReelFilter[]>(showSaved ? '/api/reel-filters' : null)");
    expect(filters).toContain("method: 'POST'");
    expect(filters).toContain('preset.config.query');
    expect(filters).toContain('Delete saved filter?');
    expect(filters).not.toContain('/api/refresh');
    expect(filters).not.toContain('localStorage');
    expect(filters).toContain('key={reset}');
  });
});
