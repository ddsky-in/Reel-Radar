import { Activity, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Competitors, CreatorDetail, SelectedCreator } from '../src/components/competitors';
import { KeywordFilter, PeriodFilter, RangeFilter, ReelFilters } from '../src/components/reel-filters';
import { ErrorState, SourceLink } from '../src/components/ui';
import type { Creator, ReelQuery } from '../src/lib/types';

type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type HookState = { slots: Slot[]; cursor: number; effects: (() => void)[] };
const fixtures = vi.hoisted(() => ({
  active: null as HookState | null,
  read: vi.fn(), invalidate: vi.fn(), api: vi.fn(),
  profile: null as Creator | null, profileError: null as string | null,
}));
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  const slot = () => fixtures.active!.slots[fixtures.active!.cursor++] ??= {};
  const changed = (previous?: readonly unknown[], next?: readonly unknown[]) => !previous || !next || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
  const effect = (callback: EffectCallback, deps?: readonly unknown[]) => {
    const current = slot();
    if (changed(current.deps, deps)) {
      fixtures.active!.effects.push(() => { current.cleanup?.(); current.cleanup = callback() || undefined; });
      current.deps = deps;
    }
  };
  return { ...react,
    useId: () => fixtures.active ? 'creator-filter-fixture' : react.useId(),
    useState: (initial: unknown) => {
      if (!fixtures.active) return react.useState(initial);
      const current = slot();
      if (!Object.hasOwn(current, 'value')) current.value = typeof initial === 'function' ? initial() : initial;
      return [current.value, (next: unknown) => { current.value = typeof next === 'function' ? next(current.value) : next; }];
    },
    useRef: (initial: unknown) => {
      if (!fixtures.active) return react.useRef(initial);
      return slot().value ??= { current: initial };
    },
    useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => fixtures.active ? factory() : react.useMemo(factory, deps),
    useEffect: (callback: EffectCallback, deps?: readonly unknown[]) => fixtures.active ? effect(callback, deps) : react.useEffect(callback, deps),
    useLayoutEffect: (callback: EffectCallback, deps?: readonly unknown[]) => fixtures.active ? effect(callback, deps) : react.useLayoutEffect(callback, deps),
  };
});
vi.mock('@/lib/resource-cache', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/resource-cache')>(), invalidateResources: fixtures.invalidate }));
vi.mock('@/lib/client', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/client')>(), api: fixtures.api }));
vi.mock('@/lib/use-resource', () => ({ useResource: (path: string | null) => {
  fixtures.read(path);
  const profile = path?.includes('/creators/') && !path.endsWith('/source-refresh');
  const data = !path ? null : profile ? fixtures.profile : path.includes('/competitors?') ? { items: fixtures.profile ? [fixtures.profile] : [], total: fixtures.profile ? 1 : 0, page: 1, limit: 50 } : path.includes('/reels?') ? { items: [], total: 0, page: 1, limit: 30 } : [];
  return { data, error: profile ? fixtures.profileError : null, loading: false, refreshing: false };
} }));

const cleanup: (() => void)[] = [];
// Same hook/event approach as the sidebar regressions. hide() models Activity's
// documented effect teardown while retaining slots; the JSX asserts identity.
function harness(render: () => ReactNode) {
  const state: HookState = { slots: [], cursor: 0, effects: [] };
  const hide = () => state.slots.forEach(slot => { slot.cleanup?.(); slot.cleanup = undefined; slot.deps = undefined; });
  cleanup.push(hide);
  return { hide, render() {
    state.cursor = 0; state.effects = []; fixtures.active = state;
    let tree: ReactNode;
    try { tree = render(); } finally { fixtures.active = null; }
    state.effects.forEach(effect => effect());
    return tree;
  } };
}
type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return isValidElement<Record<string, unknown>>(tree) ? [tree, ...elements(tree.props.children as ReactNode)] : [];
}
function find(tree: ReactNode, predicate: (element: Element) => boolean): Element {
  const element = elements(tree).find(predicate);
  if (!element) throw new Error('Missing creator detail control');
  return element;
}
function text(tree: ReactNode): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join('');
  return isValidElement<Record<string, unknown>>(tree) ? text(tree.props.children as ReactNode) : '';
}
function input(tree: ReactNode, label: string) { return find(tree, element => element.props['aria-label'] === label); }
function edit(tree: ReactNode, label: string, value: string) {
  (input(tree, label).props.onChange as (event: unknown) => void)({ target: { value, validity: { badInput: false } } });
}
function details(tree: ReactNode) { return find(tree, element => element.props.className === 'creator-filter-details'); }
function toggle(tree: ReactNode, open: boolean) { (details(tree).props.onToggle as (event: unknown) => void)({ currentTarget: { open } }); }
function filters(tree: ReactNode) { return find(tree, element => element.type === ReelFilters); }
const creator: Creator = { id: '11111111-1111-4111-8111-111111111111', username: 'ordinary_fixture', display_name: 'Synthetic fixture', avatar_url: null, followers_count: 100, status: 'active', last_profile_fetch_at: '2026-11-14T12:00:00Z', last_reels_fetch_at: '2026-11-14T13:00:00Z', last_error: null };
const workspaceId = '22222222-2222-4222-8222-222222222222';
const base = `/api/workspaces/${workspaceId}`, path = `${base}/creators/${creator.id}`;
const notify = vi.fn(), refresh = vi.fn(async () => {}), close = vi.fn();
function creatorPanel() { return harness(() => CreatorDetail({ creator, workspaceId, mode: 'demo', notify, refresh, close })); }

beforeEach(() => {
  vi.useFakeTimers(); fixtures.profile = null; fixtures.profileError = null;
  fixtures.read.mockClear(); fixtures.invalidate.mockClear(); fixtures.api.mockClear(); refresh.mockClear();
});
afterEach(() => { fixtures.active = null; cleanup.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('creator full-filter Activity release regressions', () => {
  it('always retains the full locked filter boundary, gating hidden reads without committing drafts', () => {
    const panel = creatorPanel(); let tree = panel.render();
    const first = find(tree, element => element.type === Activity);
    expect(first.props.mode).toBe('hidden'); expect(first.key).toBeNull();
    expect(details(tree).props.open).toBe(false);
    expect(filters(tree).props).toMatchObject({ enabled: false, lockedCreator: creator, workspaceId });
    const filterPanel = harness(() => ReelFilters(filters(tree).props as Parameters<typeof ReelFilters>[0]));
    fixtures.read.mockClear(); filterPanel.render(); expect(fixtures.read.mock.calls).toEqual([[null], [null]]);
    toggle(tree, true); tree = panel.render();
    expect(find(tree, element => element.type === Activity).props.mode).toBe('visible');
    expect(filters(tree).props.enabled).toBe(true);
    let filterTree = filterPanel.render();
    const rangeElement = find(filterTree, element => element.type === RangeFilter && element.props.label === 'Outlier Score');
    const periodElement = find(filterTree, element => element.type === PeriodFilter);
    const keywordElement = find(filterTree, element => element.type === KeywordFilter);
    const range = harness(() => RangeFilter(rangeElement.props as Parameters<typeof RangeFilter>[0]));
    const period = harness(() => PeriodFilter(periodElement.props as Parameters<typeof PeriodFilter>[0]));
    const keyword = harness(() => KeywordFilter(keywordElement.props as Parameters<typeof KeywordFilter>[0]));
    edit(range.render(), 'Minimum Outlier Score', '-1'); range.render();
    edit(period.render(), 'Posted in last amount', '7'); period.render();
    edit(keyword.render(), 'Keywords', 'unfinished synthetic draft '); keyword.render();
    // Hiding runs effect cleanup, but does not replace the boundary/control keys.
    toggle(tree, false); tree = panel.render(); range.hide(); period.hide(); keyword.hide(); filterPanel.hide();
    expect(find(tree, element => element.type === Activity).props.mode).toBe('hidden');
    fixtures.read.mockClear(); filterTree = filterPanel.render();
    expect(fixtures.read.mock.calls).toEqual([[null], [null]]);
    vi.advanceTimersByTime(1000);
    expect(filters(tree).props.value).toMatchObject({ creator_id: creator.id, page: 1, limit: 30 });
    expect(filters(tree).props.value).not.toHaveProperty('keywords');
    toggle(tree, true); tree = panel.render();
    expect(find(tree, element => element.type === Activity).key).toBe(first.key);
    expect(find(filterTree, element => element.props.className === 'advanced-filter-fields').key).toBe('0');
    expect(input(range.render(), 'Minimum Outlier Score').props).toMatchObject({ value: '-1', 'aria-invalid': true });
    expect(input(period.render(), 'Posted in last amount').props.value).toBe('7');
    expect(input(period.render(), 'Posted in last unit').props.value).toBe('');
    expect(input(keyword.render(), 'Keywords').props.value).toBe('unfinished synthetic draft ');
    expect(text(tree)).not.toContain('Filter Reels · active');
  });

  it('keeps committed zero criteria active while allowing collapse, and ignores mandatory/default fields after Clear', () => {
    const panel = creatorPanel(); let tree = panel.render(); toggle(tree, true); tree = panel.render();
    (filters(tree).props.onChange as (value: ReelQuery) => void)({ creator_id: creator.id, min_views: 0, sort: 'views', page: 5, limit: 30 });
    tree = panel.render(); expect(text(tree)).toContain('Filter Reels · active');
    toggle(tree, false); tree = panel.render();
    expect(details(tree).props.open).toBe(false);
    expect(find(tree, element => element.type === Activity).props.mode).toBe('hidden');
    expect(filters(tree).props.value).toMatchObject({ creator_id: creator.id, min_views: 0, page: 1, sort: 'views', limit: 30 });
    const full = harness(() => ReelFilters(filters(tree).props as Parameters<typeof ReelFilters>[0]));
    (find(full.render(), element => element.type === 'button' && text(element) === 'Clear').props.onClick as () => void)();
    tree = panel.render();
    expect(text(tree)).not.toContain('Filter Reels · active'); expect(details(tree).props.open).toBe(false);
    expect(filters(tree).props.value).toMatchObject({ creator_id: creator.id, page: 1, sort: 'views', limit: 30 });
    expect(filters(tree).props.value).not.toHaveProperty('min_views');
  });

  it('gates directory and saved-filter reads for hidden full controls, and closes transient popovers', () => {
    let enabled = true;
    const full = harness(() => ReelFilters({ workspaceId, value: {}, enabled, notify, onChange: vi.fn() }));
    let tree = full.render();
    expect(fixtures.read.mock.calls).toEqual([[`${base}/creator-directory`], [null]]);
    (find(tree, element => typeof element.props.onOpenChange === 'function').props.onOpenChange as (open: boolean) => void)(true);
    fixtures.read.mockClear(); tree = full.render(); expect(fixtures.read.mock.calls).toEqual([[`${base}/creator-directory`], ['/api/reel-filters']]);
    const popover = { matches: () => true, hidePopover: vi.fn() };
    ((tree as Element).props.ref as { current: unknown }).current = { querySelectorAll: () => [popover] };
    enabled = false; full.hide(); fixtures.read.mockClear(); tree = full.render();
    expect(fixtures.read.mock.calls).toEqual([[null], [null]]); expect(popover.hidePopover).toHaveBeenCalledOnce();
    expect(find(tree, element => typeof element.props.onOpenChange === 'function').props.children).toBe(false);
    enabled = true; fixtures.read.mockClear(); full.render();
    expect(fixtures.read.mock.calls).toEqual([[`${base}/creator-directory`], [null]]);
  });
});

describe('selected creator read retries and source provenance', () => {
  it.each([false, true])('retries only the failed profile read while preserving cached detail (%s)', cached => {
    fixtures.profile = cached ? creator : null; fixtures.profileError = 'Profile metadata unavailable';
    const tree = SelectedCreator({ base, selected: creator, mode: 'demo', notify, refresh, close });
    if (!cached) (find(tree, element => element.type === ErrorState).props.retry as () => void)();
    else {
      const detail = find(tree, element => element.type === CreatorDetail);
      expect(detail.props).toMatchObject({ creator, profileError: fixtures.profileError, mode: 'demo' });
      const ui = harness(() => CreatorDetail(detail.props as Parameters<typeof CreatorDetail>[0]));
      const content = ui.render(); expect(text(content)).toContain('Profile update failed: Profile metadata unavailable');
      (find(content, element => element.type === 'button' && text(element) === 'Retry profile check').props.onClick as () => void)();
    }
    expect(fixtures.invalidate.mock.calls).toEqual([[path]]); expect(fixtures.api).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['demo', 'supabase', undefined] as const)('uses explicit %s mode, not usernames or timestamps, for original profile links', mode => {
    const ui = harness(() => CreatorDetail({ creator, workspaceId, mode, notify, refresh, close }));
    expect(find(ui.render(), element => element.type === SourceLink).props.url).toBe(mode === 'supabase' ? `https://www.instagram.com/${creator.username}/` : null);
    const unfetched = harness(() => CreatorDetail({ creator: { ...creator, last_profile_fetch_at: null, last_reels_fetch_at: null }, workspaceId, mode, notify, refresh, close }));
    expect(find(unfetched.render(), element => element.type === SourceLink).props.url).toBeNull();
  });

  it('propagates app demo provenance into selected detail and resets across auth/creator/workspace scopes', () => {
    const app = readFileSync(join(process.cwd(), 'src/components/app.tsx'), 'utf8');
    expect(app).toContain('mode={bootstrap.mode}'); expect(app).toContain('key={`${workspace.id}-${selectionKey}`}');
    fixtures.profile = creator;
    const ui = harness(() => Competitors({ workspaceId, workspaceName: 'Synthetic workspace', mode: 'demo', notify, refresh }));
    let tree = ui.render();
    (find(tree, element => element.type === 'button' && element.props.className === 'creator-cell').props.onClick as () => void)();
    tree = ui.render();
    const selection = find(tree, element => element.type === SelectedCreator);
    expect(selection.props.mode).toBe('demo');
    const selected = SelectedCreator(selection.props as Parameters<typeof SelectedCreator>[0]);
    expect(find(selected, element => element.type === CreatorDetail).props.mode).toBe('demo');
    expect(find(selected, element => element.type === CreatorDetail).key).toBe(`${workspaceId}-${creator.id}-demo`);
  });
});
