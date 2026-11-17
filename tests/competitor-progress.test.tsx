import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { competitorProgress } from '../src/lib/competitor-progress';
import { CompetitorStatus } from '../src/components/competitors';
import type { Creator } from '../src/lib/types';

const creator: Creator = { id: 'fixture', username: 'synthetic_creator', display_name: null, avatar_url: null, followers_count: null, status: 'active', last_profile_fetch_at: null, last_reels_fetch_at: null, last_error: null };
describe('compact competitor progress', () => {
  it.each([
    ['pending', 'Import queued'], ['running', 'Importing'], ['processing', 'Importing'], ['succeeded', 'Active'],
    ['partial', 'Partial update'], ['failed', 'Import failed'], ['uncertain', 'Needs review'], ['budget_paused', 'Import waiting'],
  ] as const)('preserves truthful initial state %s', (status, label) => {
    expect(competitorProgress({ ...creator, initial_backfill_status: status }).label).toBe(label);
  });
  it('does not hide profile failures, missing state or collection pause behind Active', () => {
    expect(competitorProgress(creator, 'failed').label).toBe('Profile needs review');
    expect(competitorProgress(creator, 'partial').label).toBe('Partial update');
    expect(competitorProgress({ ...creator, status: 'pending' }).label).toBe('Pending');
    expect(competitorProgress({ ...creator, status: 'paused', initial_backfill_status: 'pending' }).label).toBe('Paused');
  });
  it('uses a single accessible details button, with no repeated row paragraphs', () => {
    const html = renderToStaticMarkup(createElement(CompetitorStatus, { creator: { ...creator, initial_backfill_status: 'pending', last_error: 'Preserved data' }, profileStatus: 'pending', open: () => {} }));
    expect(html).toContain('View synthetic_creator collection details: Import queued');
    expect(html).not.toContain('<p'); expect(html).not.toContain('Preserved data'); expect(html).not.toContain('up to 100');
  });
});
