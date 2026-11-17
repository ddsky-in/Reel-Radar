import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SourceCoverageSummary } from '../src/components/creator-source-refresh';
import { safeCreatorSourceRefresh } from '../src/lib/server/public-data';
import { DemoRepository } from '../src/lib/server/demo-repository';
import type { CreatorSourceRefresh } from '../src/lib/types';
vi.mock('@/lib/use-resource', async () => await import('../src/lib/use-resource'));

const report: CreatorSourceRefresh = {
  job_id: '11111111-1111-4111-8111-111111111111', status: 'partial', source_refresh: true, results_limit: 100,
  coverage_recorded: true, expected_reels: 41, returned_reels: 39, missing_reels: 2, missing_captions: 1, missing_media: 3,
  completed_at: '2026-11-10T12:00:00Z', missing: [{ reel_id: '22222222-2222-4222-8222-222222222222', shortcode: 'MISSING', not_returned: true, caption_missing: true, media_missing: true }],
};
describe('visible collection coverage', () => {
  it('reports missing records and fields without treating partial coverage as complete', () => {
    const html = renderToStaticMarkup(createElement(SourceCoverageSummary, { report }));
    expect(html).toContain('39 of 41 previously saved Reels returned.');
    expect(html).toContain('2 Reels not returned'); expect(html).toContain('1 captions missing');
    expect(html).toContain('MISSING'); expect(html).toContain('not returned by the provider');
  });
  it('keeps pending and historical unmeasured reports distinct from verified coverage', () => {
    const pending = renderToStaticMarkup(createElement(SourceCoverageSummary, { report: { ...report, status: 'processing' } }));
    expect(pending).toContain('Coverage will appear'); expect(pending).not.toContain('39 of 41');
    const legacy = renderToStaticMarkup(createElement(SourceCoverageSummary, { report: { ...report, source_refresh: false, coverage_recorded: false } }));
    expect(legacy).toContain('no detailed coverage report');
  });
  it('sanitizes reports and rejects malformed counts and untrusted identifiers', () => {
    const safe = safeCreatorSourceRefresh({ ...report, secret: 'private', missing: report.missing.map(row => ({ ...row, source_url: 'private' })) });
    expect(safe).toEqual({ ...report, completed_at: '2026-11-10T12:00:00.000Z' });
    expect(JSON.stringify(safe)).not.toContain('private');
    for (const patch of [{ returned_reels: -1 }, { expected_reels: 101 }, { status: 'invented' }, { missing: [{ ...report.missing[0], shortcode: 'https://evil.test/' }] }]) expect(() => safeCreatorSourceRefresh({ ...report, ...patch })).toThrow('Collection coverage could not be loaded');
  });
  it('does not fetch or manufacture real source results in demo mode', async () => {
    const repo = new DemoRepository(); const workspace = (await repo.bootstrap()).workspaces[0];
    const creator = (await repo.creators(workspace.id))[0];
    const before = await repo.jobs();
    expect(await repo.creatorSourceRefresh(workspace.id, creator.id)).toBeNull();
    await expect(repo.requestCreatorSourceRefresh(workspace.id, creator.id)).rejects.toThrow('Synthetic demo');
    expect(await repo.jobs()).toEqual(before);
  });
});
