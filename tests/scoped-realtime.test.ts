import { describe, expect, it } from 'vitest';
import { createResourceRevisionTracker } from '../src/lib/supabase/realtime';
import { resourceMatchesFamilies } from '../src/lib/resource-dependencies';

const owner = 'a0000000-0000-4000-8000-000000000001';
const workspace = 'b0000000-0000-4000-8000-000000000001';
const signal = (revision: number | string, family = 'reels', workspace_id: string | null = null, eventType = 'UPDATE') => ({
  schema: 'public', table: 'owner_resource_revisions', eventType,
  new: { owner_user_id: owner, family, workspace_id, scope_key: workspace_id ?? 'global', revision, updated_at: '2026-11-15T01:00:00Z' },
});

describe('private scoped revision validation', () => {
  it('accepts first INSERT and UPDATE as targeted family signals without exposing source IDs', () => {
    const tracker = createResourceRevisionTracker(owner);
    expect(tracker.accept(signal(1, 'saved_reels', workspace, 'INSERT'))).toEqual({ families: ['saved_reels'], workspaceId: workspace });
    expect(tracker.accept(signal(42, 'reel_filters'))).toEqual({ families: ['reel_filters'], workspaceId: null });
    const scope = tracker.accept(signal(2, 'saved_reels', workspace));
    if (!scope || typeof scope === 'string') throw new Error('expected valid scope');
    expect(resourceMatchesFamilies(`/api/workspaces/${workspace}/reels`, scope.families, scope.workspaceId)).toBe(true);
    expect(resourceMatchesFamilies(`/api/workspaces/${workspace}/creators`, scope.families, scope.workspaceId)).toBe(false);
  });
  it('tracks independent family/workspace sequences, duplicates, gaps and rollback-safe reset', () => {
    const tracker = createResourceRevisionTracker(owner);
    tracker.accept(signal(1, 'reels', workspace)); tracker.accept(signal(50, 'jobs'));
    expect(tracker.accept(signal(2, 'reels', workspace))).toEqual({ families: ['reels'], workspaceId: workspace });
    expect(tracker.accept(signal(51, 'jobs'))).toEqual({ families: ['jobs'], workspaceId: null });
    expect(tracker.accept(signal(51, 'jobs'))).toBe('ignore');
    expect(tracker.accept(signal(4, 'reels', workspace))).toBeNull();
    expect(tracker.accept(signal(5, 'reels', workspace))).toEqual({ families: ['reels'], workspaceId: workspace });
    expect(tracker.accept(signal(3, 'reels', workspace))).toBeNull();
    tracker.reset(); expect(tracker.accept(signal(100, 'reels', workspace))).toEqual({ families: ['reels'], workspaceId: workspace });
  });
  it('rejects unknown events/columns/families, malformed revisions and leaked source payloads', () => {
    const tracker = createResourceRevisionTracker(owner);
    for (const payload of [undefined, {}, signal(1, 'unknown'), signal(1, 'reels', 'bad'), signal(1, 'reels', null, 'DELETE'),
      { ...signal(1), table: 'owner_revisions' }, { ...signal(1), schema: 'other' },
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '01', '9223372036854775808', '1e2'].map(revision => signal(revision)),
      { ...signal(1), new: { ...signal(1).new, actor_run_id: 'not-public' } },
      { ...signal(1), new: { ...signal(1).new, updated_at: 'bad' } },
      { ...signal(1), new: { ...signal(1).new, workspace_id: undefined } },
    ]) expect(tracker.accept(payload)).toBeNull();
    expect(tracker.accept(signal('9007199254740993'))).toEqual({ families: ['reels'], workspaceId: null });
    expect(tracker.accept(signal('9007199254740994'))).toEqual({ families: ['reels'], workspaceId: null });
  });
  it('ignores foreign owner signals without triggering reads or poisoning own sequences', () => {
    const tracker = createResourceRevisionTracker(owner), payload = signal(9);
    expect(tracker.accept({ ...payload, new: { ...payload.new, owner_user_id: 'a0000000-0000-4000-8000-000000000002' } })).toBe('ignore');
    expect(tracker.accept(signal(1))).toEqual({ families: ['reels'], workspaceId: null });
  });
});
