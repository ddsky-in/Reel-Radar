import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectionStatus } from '../src/components/collection-status';
import { Competitors, CreatorDetail } from '../src/components/competitors';
import { collectionMessage, collectionReasons, profileCollectionLabel } from '../src/lib/collection-status';
import type { Creator, CreatorCollectionState, CreatorCollectionSummary, CreatorDirectoryEntry, PageResult } from '../src/lib/types';

const fixtures = vi.hoisted(() => ({ summary: null as CreatorCollectionSummary | null, error: null as string | null, creator: null as Creator | null, paths: [] as string[] }));
vi.mock('@/lib/use-resource', () => ({ useResource: (url: string | null) => {
  if (url) fixtures.paths.push(url);
  const rows = fixtures.creator ? [fixtures.creator] : [];
  let data: unknown = null;
  if (url?.endsWith('/collection-summary')) data = fixtures.summary;
  else if (url?.includes('/competitors?')) data = { items: rows, total: rows.length, page: 1, limit: 50 } satisfies PageResult<Creator>;
  else if (url?.endsWith('/creator-directory')) data = rows.map(({ id, username, display_name, avatar_url, status }) => ({ id, username, display_name, avatar_url, status })) satisfies CreatorDirectoryEntry[];
  else if (url?.includes('/reels?')) data = { items: [], total: 0, page: 1, limit: 30 };
  else if (url && !url.endsWith('/source-refresh')) throw new Error(`Unexpected resource: ${url}`);
  return { data, error: url?.endsWith('/collection-summary') ? fixtures.error : null, loading: false, refreshing: false };
} }));
const job = '11111111-1111-4111-8111-111111111111';
const state: CreatorCollectionState = { reason: 'unreconciled_charges', blocking_job_id: job, pending_job_ids: [job], active_job_ids: [], profiles: [] };
afterEach(() => { fixtures.summary = null; fixtures.error = null; fixtures.creator = null; fixtures.paths = []; });

describe('visible creator collection states', () => {
  it('explains owner-wide blockage without claiming imports completed or showing raw evidence', () => {
    const html = renderToStaticMarkup(createElement(CollectionStatus, { state }));
    expect(html).toContain('unresolved charge'); expect(html).toContain('New profile and Reel imports are waiting');
    expect(html).toContain('href="/jobs"'); expect(html).not.toContain(job);
    expect(html).not.toContain('completed');
  });
  it('does not invent a blocker for a ready state', () => {
    expect(renderToStaticMarkup(createElement(CollectionStatus, { state: { ...state, reason: null, blocking_job_id: null } }))).toBe('');
  });
  it('uses actionable allow-listed messages and preserves partial/failed profile distinctions', () => {
    for (const reason of collectionReasons) expect(collectionMessage(reason).length).toBeGreaterThan(20);
    expect(profileCollectionLabel('pending')).toContain('photo, name and followers · pending');
    expect(profileCollectionLabel('partial')).toContain('partially completed');
    expect(profileCollectionLabel('failed')).toContain('needs attention');
    expect(profileCollectionLabel(undefined)).toBeNull();
  });
  it('shows the actual table’s profile and initial Reel import states separately', () => {
    fixtures.creator = { id: job, username: 'synthetic_pending', display_name: null, avatar_url: null, followers_count: null, status: 'pending', last_profile_fetch_at: null, last_reels_fetch_at: null, last_error: null, tracked_reels: 0, initial_backfill_status: 'pending', profile_job_status: 'pending' };
    fixtures.summary = { reason: state.reason, blocking_job_id: job, pending_jobs: 1, active_jobs: 0 };
    const html = renderToStaticMarkup(createElement(Competitors, { workspaceId: job, workspaceName: 'Fixture', notify: () => {}, refresh: async () => {} }));
    expect(html).toContain('unresolved charge'); expect(html).toContain('Import queued');
    expect(fixtures.paths).toEqual([`/api/workspaces/${job}/competitors?search=&page=1&limit=50`, `/api/workspaces/${job}/creator-directory`, `/api/workspaces/${job}/collection-summary`]);
    expect(html).not.toContain('Profile photo, name and followers · pending');
    expect(html).not.toContain('Initial import: up to 100 Reels · pending');
    const detail = renderToStaticMarkup(createElement(CreatorDetail, { creator: fixtures.creator!, profileStatus: 'pending', workspaceId: job, notify: () => {}, refresh: async () => {}, close: () => {} }));
    expect(detail).toContain('Profile photo, name and followers · pending');
    expect(detail).toContain('Initial import: up to 100 Reels · pending');
    fixtures.creator.last_reels_fetch_at = '2026-11-14T17:30:00Z';
    const fetched = renderToStaticMarkup(createElement(Competitors, { workspaceId: job, workspaceName: 'Fixture', notify: () => {}, refresh: async () => {} }));
    expect(fetched).toContain('14 Nov 2026'); expect(fetched).toContain('11:00 pm IST');
    fixtures.summary = null; fixtures.error = 'Status unavailable';
    const failed = renderToStaticMarkup(createElement(Competitors, { workspaceId: job, workspaceName: 'Fixture', notify: () => {}, refresh: async () => {} }));
    expect(failed).toContain('Collection status unavailable'); expect(failed).toContain('synthetic_pending');
  });
});
