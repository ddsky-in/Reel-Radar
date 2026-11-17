import { Activity, createElement, isValidElement, type EffectCallback, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelPicker, KeywordFilter, PeriodFilter, RangeFilter, ReelFilters, ReelPagination, useFilterSidebarVisibility } from '../src/components/reel-filters';
import { CarouselFilters } from '../src/components/carousel-filters';
import type { CarouselQuery, Creator, ReelQuery, SavedCarouselFilter, SavedReelFilter } from '../src/lib/types';

const resources = vi.hoisted(() => ({ read: vi.fn(), channels: [] as Creator[], reels: [] as SavedReelFilter[], carousels: [] as SavedCarouselFilter[] }));
const hooks = vi.hoisted(() => ({ active: null as null | { states: unknown[]; cursor: number; effects?: EffectCallback[] } }));
vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return { ...react,
    useId: () => hooks.active ? 'sidebar-fixture' : react.useId(),
    useState: (initial: unknown) => {
      const active = hooks.active;
      if (!active) return react.useState(initial);
      const index = active.cursor++;
      if (!(index in active.states)) active.states[index] = typeof initial === 'function' ? initial() : initial;
      return [active.states[index], (next: unknown) => { active.states[index] = typeof next === 'function' ? next(active.states[index]) : next; }];
    },
    useRef: (initial: unknown) => {
      if (!hooks.active) return react.useRef(initial);
      const active = hooks.active, index = active.cursor++;
      if (!(index in active.states)) active.states[index] = { current: initial };
      return active.states[index];
    },
    useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => hooks.active ? factory() : react.useMemo(factory, deps),
    useEffect: (effect: EffectCallback, deps: readonly unknown[]) => { if (hooks.active) hooks.active.effects?.push(effect); else react.useEffect(effect, deps); },
    useLayoutEffect: (effect: EffectCallback, deps: readonly unknown[]) => { if (!hooks.active) react.useLayoutEffect(effect, deps); },
  };
});
vi.mock('../src/components/ui', async () => {
  const ui = await vi.importActual<typeof import('../src/components/ui')>('../src/components/ui');
  return { ...ui, useResource: (path: string | null) => {
    resources.read(path);
    const data = !path ? null : path === '/api/reel-filters' ? resources.reels : path === '/api/carousel-filters' ? resources.carousels : resources.channels;
    return { data, loading: false, error: null };
  } };
});
afterEach(() => { hooks.active = null; resources.read.mockClear(); resources.channels = []; resources.reels = []; resources.carousels = []; vi.unstubAllGlobals(); vi.useRealTimers(); });

function harness(renderControl: () => ReactNode) {
  const state = { states: [] as unknown[], cursor: 0, effects: [] as EffectCallback[] };
  return { render() {
    state.cursor = 0; state.effects = []; hooks.active = state;
    try { return renderControl(); } finally { hooks.active = null; }
  }, effects: () => state.effects };
}
function collapseEvent() { return { currentTarget: { closest: () => null, focus: vi.fn() } }; }
function toggle(tree: ReactNode) { return find(tree, props => String(props.className).includes('filter-sidebar-toggle')); }

function markup(layout: 'full' | 'sidebar', value: ReelQuery = {}) {
  return renderToStaticMarkup(createElement(ReelFilters, { workspaceId: 'fixture', value, layout, onChange: () => {}, notify: () => {} }));
}
function find(tree: ReactNode, predicate: (props: Record<string, unknown>) => boolean): Record<string, unknown> {
  if (Array.isArray(tree)) {
    for (const child of tree) { try { return find(child, predicate); } catch { /* Search sibling nodes. */ } }
  } else if (isValidElement<Record<string, unknown>>(tree)) {
    if (predicate(tree.props)) return tree.props;
    if (tree.props.children) return find(tree.props.children as ReactNode, predicate);
  }
  throw new Error('Missing sidebar node');
}

describe('responsive sidebar filter presentation', () => {
  it('keeps the full shared variant unchanged and adds only sidebar-specific controls', () => {
    const full = markup('full'), sidebar = markup('sidebar');
    expect(full).not.toContain('filter-sidebar-content');
    expect(full).not.toContain('Hide filters');
    expect(full).toContain('Advanced filters');
    expect(sidebar).toContain('filter-sidebar-panel');
    expect(sidebar).toContain('filter-sidebar-content');
    expect(sidebar).toContain('aria-expanded="true"');
    expect(sidebar).toContain('Hide filters');
    expect(sidebar.match(/>Save filter<\/button>/gi)).toHaveLength(1);
    expect(sidebar).toContain('filter-sidebar-save');
  });
  it('shows compact neutral controls without imposing the reference image bounds', () => {
    const sidebar = markup('sidebar');
    for (const example of ['0', '100x', '10,000,000', '100%']) expect(sidebar).toContain(`placeholder="${example}"`);
    for (const label of ['Minimum Outlier Score', 'Maximum Outlier Score', 'Minimum Views', 'Maximum Views', 'Minimum Engagement', 'Maximum Engagement', 'Posted in last amount', 'Posted in last unit', 'Keywords']) expect(sidebar).toContain(`aria-label="${label}"`);
    expect(sidebar).not.toContain('No active filters');
    expect(sidebar).toContain('placeholder="Any"');
    expect(sidebar).toContain('value="" selected="">Unit');
    expect(sidebar).toContain('Search captions and titles');
    expect(sidebar).not.toContain('aria-invalid="true"');
    expect(sidebar.match(/<input[^>]*type="number"[^>]*value=""/g)).toHaveLength(9);
  });
  it('preserves explicit zero and one-sided bounds in the compact active count', () => {
    const sidebar = markup('sidebar', { min_views: 0, max_outlier: 3 });
    expect(sidebar).toMatch(/class="filter-active-count"[^>]*>2<\/span>/);
    expect(sidebar).not.toContain('Remove Views filter');
    expect(sidebar).toMatch(/aria-label="Minimum Views"[^>]*value="0"/);
    expect(sidebar).toMatch(/aria-label="Maximum Views"[^>]*value=""/);
  });
  it('clears sidebar criteria while preserving required creator/bookmark scopes and sorting', () => {
    const lockedCreator = creator('11111111-1111-4111-8111-111111111111', 'studio');
    const value: ReelQuery = { min_views: 0, max_views: 100, posted_amount: 7, posted_unit: 'days', creator_id: lockedCreator.id, saved: true, sort: 'views', limit: 20, page: 4 };
    const onChange = vi.fn(), unchanged = { ...value };
    hooks.active = { states: [], cursor: 0 };
    const tree = ReelFilters({ workspaceId: 'fixture', value, layout: 'sidebar', lockedCreator, savedOnly: true, onChange, notify: () => {} });
    hooks.active = null;
    (find(tree, props => props.children === 'Clear' && typeof props.onClick === 'function').onClick as () => void)();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ creator_id: lockedCreator.id, saved: true, sort: 'views', limit: 20, page: 1 });
    expect(value).toEqual(unchanged);
  });
  it('collapses reads and rendering while preserving stateful controls and committed criteria', () => {
    const value: ReelQuery = { min_views: 0, max_views: 100, posted_amount: 7, posted_unit: 'days' };
    const unchanged = { ...value }, onChange = vi.fn();
    const panel = harness(() => ReelFilters({ workspaceId: 'fixture', value, layout: 'sidebar', onChange, notify: () => {} }));
    const before = panel.render(), content = find(before, props => props.className === 'filter-sidebar-content');
    expect(toggle(before)['aria-expanded']).toBe(true);
    expect(toggle(before)['aria-controls']).toBe(content.id);
    resources.read.mockClear();
    (toggle(before).onClick as (event: unknown) => void)(collapseEvent());
    const collapsed = panel.render();
    expect(find(collapsed, props => String(props.className).includes('filter-sidebar-panel')).className).toContain('filter-sidebar-collapsed');
    expect(find(collapsed, props => props.className === 'filter-sidebar-content')).toMatchObject({ id: content.id, hidden: true });
    expect(toggle(collapsed)['aria-expanded']).toBe(false);
    expect(find(collapsed, props => props.mode === 'hidden')).toHaveProperty('children');
    expect(renderToStaticMarkup(collapsed)).not.toContain('aria-label="Maximum Views"');
    expect(resources.read.mock.calls).toEqual([[null], [null]]);
    expect(value).toEqual(unchanged); expect(onChange).not.toHaveBeenCalled();
    resources.read.mockClear();
    (toggle(collapsed).onClick as (event: unknown) => void)(collapseEvent());
    const reopened = panel.render();
    expect(toggle(reopened)['aria-expanded']).toBe(true);
    expect(resources.read.mock.calls).toEqual([['/api/workspaces/fixture/creator-directory'], [null]]);
    expect(renderToStaticMarkup(reopened)).toMatch(/aria-label="Maximum Views"[^>]*value="100"/);
  });
  it('uses a real left-filter/right-results wrapper and keeps export in the results toolbar', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/explorer.tsx'), 'utf8');
    expect(source).toContain('className="reel-explorer-layout"');
    expect(source.indexOf('className="reel-filter-sidebar"')).toBeLessThan(source.indexOf('className="reel-explorer-results"'));
    expect(source).toContain('layout="sidebar"');
    expect(source).toContain('explorer-export');
    expect(source).toContain("activeFilterItems(query, { savedOnly: isSaved }).length > 0");
  });
  it('restores desktop visibility and keeps mobile controls stateful instead of unmounting', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toMatch(/@container research \(min-width: \d+(?:\.\d+)?rem\)/);
    expect(css).toMatch(/\.reel-explorer-layout\s*\{\s*grid-template-columns: [^;]+ minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.filter-sidebar-panel\.filter-sidebar-collapsed > \.filter-sidebar-content\s*\{ display: block;/);
    expect(css).toMatch(/scroll-padding-block: [^;]+;/);
  });

  it('tracks the existing desktop CSS on resize and disconnects its observer', async () => {
    const resize = vi.fn(), remove = vi.fn(), observe = vi.fn(), disconnect = vi.fn();
    let resized = () => {};
    vi.stubGlobal('window', { addEventListener: resize, removeEventListener: remove });
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback; } observe = observe; disconnect = disconnect; });
    let display = 'inline-flex';
    vi.stubGlobal('getComputedStyle', () => ({ display }));
    const visibility = harness(() => useFilterSidebarVisibility(false) as unknown as ReactNode);
    const initial = visibility.render() as unknown as ReturnType<typeof useFilterSidebarVisibility>;
    const container = {};
    initial.toggleRef.current = { closest: () => container } as unknown as HTMLButtonElement;
    const cleanup = visibility.effects()[0]();
    await Promise.resolve();
    expect(observe).toHaveBeenCalledWith(container);
    expect((visibility.render() as unknown as ReturnType<typeof useFilterSidebarVisibility>).visible).toBe(false);
    display = 'none'; resized();
    expect((visibility.render() as unknown as ReturnType<typeof useFilterSidebarVisibility>).visible).toBe(true);
    display = 'inline-flex'; resized();
    expect((visibility.render() as unknown as ReturnType<typeof useFilterSidebarVisibility>).visible).toBe(false);
    if (typeof cleanup === 'function') cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it.each(['reels', 'carousels'] as const)('closes transient %s popovers and keeps focus on the collapse trigger', kind => {
    const panel = harness(() => kind === 'reels'
      ? ReelFilters({ workspaceId: 'fixture', value: {}, layout: 'sidebar', onChange: vi.fn(), notify: vi.fn() })
      : CarouselFilters({ workspaceId: 'fixture', value: {}, onChange: vi.fn(), notify: vi.fn() }));
    const open = panel.render();
    (find(open, props => typeof props.onOpenChange === 'function').onOpenChange as (open: boolean) => void)(true);
    const popover = { matches: () => true, hidePopover: vi.fn() }, details = { open: true }, focus = vi.fn();
    const section = { querySelectorAll: (selector: string) => selector === '[popover]' ? [popover] : [details] };
    const event = { currentTarget: { closest: () => section, focus } };
    (toggle(panel.render()).onClick as (event: unknown) => void)(event);
    const collapsed = panel.render();
    expect(popover.hidePopover).toHaveBeenCalledOnce(); expect(details.open).toBe(false); expect(focus).toHaveBeenCalledOnce();
    expect(find(collapsed, props => typeof props.onOpenChange === 'function').children).toBe(false);
    expect(toggle(collapsed)['aria-expanded']).toBe(false);
  });
});

describe('lazy saved-filter and carousel controls', () => {
  const studio = creator('11111111-1111-4111-8111-111111111111', 'studio');
  const presetQuery = { creator_ids: [studio.id], min_outlier: 0, keywords: 'synthetic caption', posted_amount: 2, posted_unit: 'weeks' as const };

  it.each(['reels', 'carousels'] as const)('loads and renders %s presets only while the saved popover is open', kind => {
    resources.reels = [{ id: 'saved-reel', name: 'Synthetic Reel preset', config: { version: 1, query: presetQuery }, created_at: '2026-11-15T00:00:00Z' }];
    resources.carousels = [{ id: 'saved-carousel', name: 'Synthetic carousel preset', config: { version: 1, query: presetQuery }, created_at: '2026-11-15T00:00:00Z' }];
    const onChange = vi.fn();
    const panel = harness(() => kind === 'reels'
      ? ReelFilters({ workspaceId: 'fixture', value: { sort: 'views', page: 3 }, layout: 'sidebar', savedOnly: true, onChange, notify: vi.fn() })
      : CarouselFilters({ workspaceId: 'fixture', value: { sort: 'latest', page: 3 }, savedOnly: true, onChange, notify: vi.fn() }));
    const closed = panel.render();
    const saved = find(closed, props => typeof props.onOpenChange === 'function');
    expect(saved.children).toBe(false);
    expect(resources.read.mock.calls).toEqual([['/api/workspaces/fixture/creator-directory'], [null]]);
    expect(renderToStaticMarkup(closed)).not.toContain('Synthetic');
    resources.read.mockClear();
    (saved.onOpenChange as (open: boolean) => void)(true);
    const open = panel.render();
    expect(resources.read.mock.calls).toEqual([['/api/workspaces/fixture/creator-directory'], [`/api/${kind === 'reels' ? 'reel' : 'carousel'}-filters`]]);
    expect(renderToStaticMarkup(open)).toContain(kind === 'reels' ? 'Synthetic Reel preset' : 'Synthetic carousel preset');
    expect(onChange).not.toHaveBeenCalled();
    vi.stubGlobal('document', { getElementById: () => null });
    const apply = find(open, props => Array.isArray(props.children) && props.children.some(child => typeof child === 'string' && child.startsWith('Synthetic')));
    (apply.onClick as () => void)();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...presetQuery, saved: true, page: 1 });
    resources.read.mockClear();
    const after = panel.render();
    expect(find(after, props => typeof props.onOpenChange === 'function').children).toBe(false);
    expect(resources.read.mock.calls).toEqual([['/api/workspaces/fixture/creator-directory'], [null]]);
    (find(after, props => typeof props.onOpenChange === 'function').onOpenChange as (open: boolean) => void)(true);
    (find(panel.render(), props => typeof props.onOpenChange === 'function').onOpenChange as (open: boolean) => void)(false);
    expect(find(panel.render(), props => typeof props.onOpenChange === 'function').children).toBe(false);
  });

  it('does not load any directory for creator-locked Reels', () => {
    const panel = harness(() => ReelFilters({ workspaceId: 'fixture', value: {}, layout: 'sidebar', lockedCreator: studio, onChange: vi.fn(), notify: vi.fn() }));
    panel.render(); expect(resources.read.mock.calls).toEqual([[null], [null]]);
  });

  it('pauses carousel directory reads on collapse and preserves committed zeroes and saved scope', () => {
    const value: CarouselQuery = { ...presetQuery, max_outlier: 2, saved: true, sort: 'follower_engagement', page: 3 };
    const onChange = vi.fn(), unchanged = { ...value };
    const panel = harness(() => CarouselFilters({ workspaceId: 'fixture', value, savedOnly: true, onChange, notify: vi.fn() }));
    const before = panel.render(), content = find(before, props => props.className === 'filter-sidebar-content');
    (toggle(before).onClick as (event: unknown) => void)(collapseEvent());
    resources.read.mockClear();
    const collapsed = panel.render();
    expect(resources.read.mock.calls).toEqual([[null], [null]]);
    expect(find(collapsed, props => props.className === 'filter-sidebar-content')).toMatchObject({ id: content.id, hidden: true });
    expect(renderToStaticMarkup(collapsed)).not.toContain('Minimum Outlier Score');
    expect(onChange).not.toHaveBeenCalled(); expect(value).toEqual(unchanged);
    (toggle(collapsed).onClick as (event: unknown) => void)(collapseEvent());
    const reopened = panel.render();
    expect(renderToStaticMarkup(reopened)).toMatch(/aria-label="Minimum Outlier Score"[^>]*value="0"/);
    expect(find(reopened, props => props.className === 'filter-sidebar-content').id).toBe(content.id);
  });

  it.each(['reels', 'carousels'] as const)('retains %s child-local invalid range, incomplete period, and keyword drafts in the same Activity boundary', kind => {
    const onChange = vi.fn();
    const panel = harness(() => kind === 'reels'
      ? ReelFilters({ workspaceId: 'fixture', value: {}, layout: 'sidebar', onChange, notify: vi.fn() })
      : CarouselFilters({ workspaceId: 'fixture', value: {}, onChange, notify: vi.fn() }));
    const before = panel.render();
    const boundary = find(before, props => props.mode === 'visible');
    const rangeProps = find(boundary.children as ReactNode, props => props.label === 'Outlier Score');
    const periodProps = find(boundary.children as ReactNode, props => props.compact === true && typeof props.value === 'object');
    const keywordProps = find(boundary.children as ReactNode, props => props.compact === true && props.value === '');
    const range = harness(() => RangeFilter(rangeProps as Parameters<typeof RangeFilter>[0]));
    const period = harness(() => PeriodFilter(periodProps as Parameters<typeof PeriodFilter>[0]));
    const keyword = harness(() => KeywordFilter(keywordProps as Parameters<typeof KeywordFilter>[0]));
    const edit = (tree: ReactNode, label: string, text: string) => {
      (find(tree, props => props['aria-label'] === label).onChange as (event: unknown) => void)({ target: { value: text, validity: { badInput: false } } });
    };
    edit(range.render(), 'Minimum Outlier Score', '-1');
    edit(period.render(), 'Posted in last amount', '7');
    edit(keyword.render(), 'Keywords', 'unfinished synthetic draft ');
    (toggle(before).onClick as (event: unknown) => void)(collapseEvent());
    const collapsed = panel.render();
    expect(find(collapsed, props => props.mode === 'hidden')).toHaveProperty('children');
    (toggle(collapsed).onClick as (event: unknown) => void)(collapseEvent());
    const reopened = panel.render();
    // Activity changes visibility, not child identity or reset keys; effects are
    // suspended by React while hidden, and these local state instances survive.
    const activity = findElement(reopened, element => element.type === Activity);
    expect(activity.key).toBe(null); expect(activity.props.mode).toBe('visible');
    expect(find(range.render(), props => props['aria-label'] === 'Minimum Outlier Score')).toMatchObject({ value: '-1', 'aria-invalid': true });
    expect(find(period.render(), props => props['aria-label'] === 'Posted in last amount').value).toBe('7');
    expect(find(period.render(), props => props['aria-label'] === 'Posted in last unit').value).toBe('');
    expect(find(keyword.render(), props => props['aria-label'] === 'Keywords').value).toBe('unfinished synthetic draft ');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('preserves competitors pagination wording', () => {
    expect(renderToStaticMarkup(createElement(ReelPagination, { page: 1, limit: 50, count: 50, total: 75, loading: false, onPage: vi.fn(), itemLabel: 'competitors' }))).toContain('Showing 1–50 of 75 competitors');
  });
});

function findElement(tree: ReactNode, predicate: (element: React.ReactElement<Record<string, unknown>>) => boolean): React.ReactElement<Record<string, unknown>> {
  if (Array.isArray(tree)) {
    for (const child of tree) { try { return findElement(child, predicate); } catch { /* Search siblings. */ } }
  } else if (isValidElement<Record<string, unknown>>(tree)) {
    if (predicate(tree)) return tree;
    return findElement(tree.props.children as ReactNode, predicate);
  }
  throw new Error('Missing element');
}

function creator(id: string, username: string): Creator {
  return { id, username, display_name: null, avatar_url: null, followers_count: null, last_profile_fetch_at: null, status: 'active', last_reels_fetch_at: null, last_error: null };
}

describe('compact channel selector', () => {
  const studio = creator('11111111-1111-4111-8111-111111111111', 'studio');
  const research = creator('22222222-2222-4222-8222-222222222222', 'research');
  const creators = [studio, research];
  const picker = (onChange = vi.fn(), selected?: string[], expanded = false) => {
    hooks.active = { states: [expanded, ''], cursor: 0 };
    try { return ChannelPicker({ id: 'channel-fixture', creators, selected, onChange }); }
    finally { hooks.active = null; }
  };

  it('uses a closed native dropdown with described selection and explicit All channels reset', () => {
    const onChange = vi.fn(), tree = picker(onChange);
    const html = renderToStaticMarkup(tree);
    expect(html).toMatch(/^<details\b/);
    expect(html.match(/^<details[^>]*>/)?.[0]).not.toContain('open=');
    expect(find(tree, props => props['aria-label'] === 'Filter channels dropdown')).toMatchObject({ 'aria-describedby': 'channel-fixture-selection', 'aria-controls': 'channel-fixture-menu', title: 'All channels' });
    expect(find(tree, props => props.role === 'group')).toMatchObject({ id: 'channel-fixture-menu', 'aria-label': 'Filter channels' });
    expect(onChange).not.toHaveBeenCalled();
    const all = find(tree, props => props['aria-pressed'] === true && typeof props.onClick === 'function');
    (all.onClick as () => void)();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('toggles multiple chosen channels without silently discarding unavailable selections', () => {
    const onChange = vi.fn(), unavailable = '33333333-3333-4333-8333-333333333333';
    const selected = [studio.id, unavailable], tree = picker(onChange, selected, true);
    expect(find(tree, props => props['aria-label'] === 'Filter channel @studio')['aria-pressed']).toBe(true);
    expect(find(tree, props => props['aria-label'] === 'Filter channel @research')['aria-pressed']).toBe(false);
    (find(tree, props => props['aria-label'] === 'Filter channel @research').onClick as () => void)();
    expect(onChange).toHaveBeenLastCalledWith([studio.id, unavailable, research.id]);
    (find(tree, props => props['aria-label'] === 'Filter channel @studio').onClick as () => void)();
    expect(onChange).toHaveBeenLastCalledWith([unavailable]);
    expect(selected).toEqual([studio.id, unavailable]);
  });

  it('preserves explicit empty selection until the user changes it and locks creator scope', () => {
    const onChange = vi.fn(), tree = picker(onChange, []);
    expect(find(tree, props => props['aria-label'] === 'Filter channels dropdown').title).toBe('No channels selected');
    expect(renderToStaticMarkup(tree)).not.toContain('aria-pressed="true"');
    expect(onChange).not.toHaveBeenCalled();
    const locked = renderToStaticMarkup(createElement(ChannelPicker, { id: 'locked', creators, selected: [research.id], lockedCreator: studio, onChange }));
    expect(locked).toContain('Channel restricted to @studio');
    expect(locked).not.toContain('<details');
    expect(locked).not.toContain('<button');
  });

  it('closes on Escape and returns focus without clearing the selected channels', () => {
    const onChange = vi.fn(), tree = picker(onChange, [studio.id]);
    const focus = vi.fn(), querySelector = vi.fn(() => ({ focus }));
    const currentTarget = { open: true, querySelector };
    const event = { key: 'Escape', currentTarget, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (find(tree, props => typeof props.onKeyDown === 'function').onKeyDown as (event: unknown) => void)(event);
    expect(currentTarget.open).toBe(false);
    expect(querySelector).toHaveBeenCalledWith('summary');
    expect(focus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the dropdown open for internal focus changes and closes when focus leaves', () => {
    const onChange = vi.fn(), tree = picker(onChange, [studio.id]);
    const inside = {}, contains = vi.fn(target => target === inside);
    const currentTarget = { open: true, contains, querySelector: vi.fn() };
    const onBlur = find(tree, props => typeof props.onBlur === 'function').onBlur as (event: unknown) => void;
    onBlur({ currentTarget, relatedTarget: inside });
    expect(currentTarget.open).toBe(true);
    onBlur({ currentTarget, relatedTarget: null });
    expect(currentTarget.open).toBe(false);
    expect(currentTarget.querySelector).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
