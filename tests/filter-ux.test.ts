import { createElement, isValidElement, type EffectCallback, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeFilterItems, clearFilterCriteria, PeriodFilter, RangeFilter, ReelFilters, removeFilterCriteria } from '../src/components/reel-filters';
import type { Creator, ReelQuery } from '../src/lib/types';

const hooks = vi.hoisted(() => ({ active: null as null | { states: unknown[]; cursor: number; effects: EffectCallback[] } }));
vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return {
    ...react,
    useId: () => hooks.active ? 'filter-ux' : react.useId(),
    useState: (initial: unknown) => {
      const active = hooks.active;
      if (!active) return react.useState(initial);
      const index = active.cursor++;
      if (!(index in active.states)) active.states[index] = typeof initial === 'function' ? initial() : initial;
      return [active.states[index], (next: unknown) => { active.states[index] = typeof next === 'function' ? next(active.states[index]) : next; }];
    },
    useRef: (initial: unknown) => hooks.active ? { current: initial } : react.useRef(initial),
    useLayoutEffect: (effect: EffectCallback, deps: readonly unknown[]) => {
      if (hooks.active) hooks.active.effects.push(effect);
      else react.useLayoutEffect(effect, deps);
    },
    useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => hooks.active ? factory() : react.useMemo(factory, deps),
    useEffect: (effect: EffectCallback, deps: readonly unknown[]) => {
      if (hooks.active) hooks.active.effects.push(effect);
      else react.useEffect(effect, deps);
    },
  };
});
vi.mock('../src/components/ui', async () => {
  const ui = await vi.importActual<typeof import('../src/components/ui')>('../src/components/ui');
  return { ...ui, useResource: () => ({ data: [], loading: false, error: '' }) };
});

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); hooks.active = null; vi.useRealTimers(); });
function controlHarness(renderControl: () => ReactNode) {
  const state = { states: [] as unknown[], cursor: 0, effects: [] as EffectCallback[] };
  let effects: (() => void)[] = [];
  cleanups.push(() => effects.forEach(cleanup => cleanup()));
  return { render() {
    effects.forEach(cleanup => cleanup());
    state.cursor = 0; state.effects = []; hooks.active = state;
    let tree: ReactNode;
    try { tree = renderControl(); } finally { hooks.active = null; }
    effects = state.effects.map(effect => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === 'function');
    return tree;
  } };
}
type Control = {
  value: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string;
  onChange: (event: { target: { value: string; validity: { badInput: boolean } } }) => void;
  onBlur: () => void; onClick: () => void;
};
function control(tree: ReactNode, label: string): Control {
  if (Array.isArray(tree)) {
    for (const child of tree) { try { return control(child, label); } catch { /* Search siblings. */ } }
  } else if (isValidElement<{ 'aria-label'?: string; children?: ReactNode }>(tree)) {
    if (tree.props['aria-label'] === label) return tree.props as unknown as Control;
    if (tree.props.children) return control(tree.props.children, label);
  }
  throw new Error(`Missing control: ${label}`);
}
function change(input: Control, value: string) { input.onChange({ target: { value, validity: { badInput: false } } }); }
function markup(value: ReelQuery = {}, scope: { savedOnly?: boolean; lockedCreator?: Creator } = {}) {
  return renderToStaticMarkup(createElement(ReelFilters, { workspaceId: 'workspace', value, onChange: () => {}, notify: () => {}, ...scope }));
}
const creator: Creator = { id: '11111111-1111-4111-8111-111111111111', username: 'studio', display_name: null, avatar_url: null, followers_count: null, last_profile_fetch_at: null, status: 'active', last_reels_fetch_at: null, last_error: null };

describe('grouped filter criteria', () => {
  it('counts only actual criteria, grouping both endpoints and keyword/search without losing zero', () => {
    const items = activeFilterItems({ min_views: 0, max_views: 0, max_outlier: 3, min_engagement: 0, posted_amount: 7, posted_unit: 'days', from: '2026-11-01', keywords: 'AI', search: 'tutorial', creator_ids: [creator.id], platform: 'instagram', freshness: 'fresh', status: 'active', saved: true, sort: 'views', page: 3, limit: 20 }, {}, [creator]);
    expect(items).toHaveLength(10);
    expect(items.some(item => item.id === 'Platform')).toBe(false);
    expect(items.find(item => item.id === 'Views')).toEqual({ id: 'Views', label: 'Views: 0–0', keys: ['min_views', 'max_views'] });
    expect(items.find(item => item.id === 'Keywords')?.keys).toEqual(['keywords', 'search']);
    expect(items.find(item => item.id === 'Channels')?.label).toBe('Channels: @studio');
  });
  it('excludes defaults, incomplete periods and mandatory scopes from the count', () => {
    expect(activeFilterItems({ freshness: 'all', saved: false, sort: 'outlier', keywords: '  ', posted_amount: 7 })).toEqual([]);
    expect(activeFilterItems({ posted_unit: 'days' })).toEqual([]);
    expect(activeFilterItems({ creator_id: 'locked', saved: true }, { creatorId: 'locked', savedOnly: true })).toEqual([]);
    const html = markup({ creator_id: 'locked', saved: true }, { lockedCreator: creator, savedOnly: true });
    expect(html).toContain('No active filters');
    expect(html).toContain('Creator scope'); expect(html).toContain('Saved Reels scope');
    expect(html).not.toContain('Remove Channels filter'); expect(html).not.toContain('Remove Saved Reels filter');
  });
  it('keeps an explicit empty channel selection distinct from All channels without exposing IDs', () => {
    expect(activeFilterItems({ creator_ids: [] })[0]?.label).toBe('No channels selected');
    expect(activeFilterItems({ creator_ids: ['private-id'] })[0]?.label).toBe('Channels: Unavailable channel');
    expect(activeFilterItems({})).toEqual([]);
  });
  it('clears an entire group while preserving unrelated criteria, sorting and scopes', () => {
    const query: ReelQuery = { min_views: 0, max_views: 100, keywords: 'AI tutorial', sort: 'views', limit: 20, page: 5, saved: true, creator_id: 'locked' };
    const before = { ...query };
    expect(removeFilterCriteria(query, ['min_views', 'max_views'], { savedOnly: true, creatorId: 'locked' })).toEqual({ ...query, min_views: undefined, max_views: undefined, page: 1 });
    expect(removeFilterCriteria(query, ['saved', 'creator_id'], { savedOnly: true, creatorId: 'locked' })).toEqual({ ...query, page: 1 });
    expect(query).toEqual(before);
  });
  it('Clear removes user criteria and drafts without imposing numeric, channel or time defaults', () => {
    const query: ReelQuery = { min_outlier: 0, max_views: 100, posted_amount: 9, posted_unit: 'months', keywords: 'AI', creator_ids: [], platform: 'instagram', freshness: 'stale', saved: false, sort: 'engagement', limit: 20, page: 4 };
    expect(clearFilterCriteria(query, { savedOnly: true, creatorId: 'locked' })).toEqual({ sort: 'engagement', limit: 20, saved: true, creator_id: 'locked', page: 1 });
    expect(activeFilterItems(clearFilterCriteria(query))).toEqual([]);
    expect(query.min_outlier).toBe(0);
  });
  it('renders removable chips and removes both Views bounds through the real handler', () => {
    const onChange = vi.fn();
    const value: ReelQuery = { min_views: 0, max_views: 100, keywords: 'AI', sort: 'views', saved: true, creator_id: creator.id };
    const harness = controlHarness(() => ReelFilters({ workspaceId: 'workspace', value, onChange, notify: () => {}, savedOnly: true, lockedCreator: creator }));
    control(harness.render(), 'Remove Views filter').onClick();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...value, min_views: undefined, max_views: undefined, page: 1 });
    const html = markup({ min_views: 0, max_views: 100 });
    expect(html).toContain('1 active filter'); expect(html).toContain('class="filter-chip"');
  });
});

describe('persistent accessible filter guidance', () => {
  it('renders visible Min/Max labels, separated groups, keyword guidance and date format help', () => {
    const html = markup();
    expect(html.match(/<span>Min<\/span>/g)).toHaveLength(4);
    expect(html.match(/<span>Max<\/span>/g)).toHaveLength(4);
    expect(html.match(/Leave either blank for no limit\./g)).toHaveLength(4);
    for (const token of ['advanced-filter-metrics', 'advanced-filter-search', '<span>Amount</span>', '<span>Unit</span>', 'All time', 'e.g. AI tutorial', 'Matches caption/title previews.', 'Dates use IST.', 'Select a date from the calendar.']) expect(html).toContain(token);
    expect(html).toContain('maxLength="200"');
    const dates = html.match(/<input\b[^>]*aria-label="Published (?:from|to)"[^>]*>/g) ?? [];
    expect(dates).toHaveLength(2);
    dates.forEach(input => { expect(input).toContain('aria-describedby='); expect(input).toContain('role="combobox"'); expect(input).toContain('placeholder="Select date"'); });
    expect(html).not.toContain('aria-pressed="true"');
  });
  it.each([{ min_views: 0 }, { max_views: 1000000 }, { min_views: 0, max_views: 0 }])('keeps one-sided and zero values valid with persistent hints: %j', value => {
    const html = markup(value);
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).toContain('Leave either blank for no limit.'); expect(html).toContain('1 active filter');
  });
  it('links range errors and hints while marking only the invalid field', () => {
    const onChange = vi.fn();
    const harness = controlHarness(() => RangeFilter({ label: 'Views', minimum: 0, maximum: 100, low: undefined, high: undefined, onChange }));
    change(control(harness.render(), 'Minimum Views'), '-1');
    const tree = harness.render();
    expect(control(tree, 'Minimum Views')['aria-invalid']).toBe(true);
    expect(control(tree, 'Maximum Views')['aria-invalid']).toBe(false);
    expect(control(tree, 'Minimum Views')['aria-describedby']).toBe('filter-ux-hint filter-ux-error');
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('id="filter-ux-hint"'); expect(html).toContain('id="filter-ux-error"');
    control(tree, 'Minimum Views').onBlur(); expect(onChange).not.toHaveBeenCalled();
  });
  it('does not commit placeholder examples on neutral control mount or debounce', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const range = controlHarness(() => RangeFilter({ label: 'Views', minimum: 0, maximum: 10000000, onChange }));
    const period = controlHarness(() => PeriodFilter({ value: {}, onChange }));
    const panel = controlHarness(() => ReelFilters({ workspaceId: 'workspace', value: {}, onChange, notify: () => {} }));
    range.render(); period.render(); panel.render();
    vi.advanceTimersByTime(500); expect(onChange).not.toHaveBeenCalled();
  });
  it.each([{ posted_amount: 7 }, { posted_unit: 'weeks' as const }])('describes partial initial periods without mutating them: %j', value => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const harness = controlHarness(() => PeriodFilter({ value, onChange }));
    const tree = harness.render(); control(tree, 'Posted in last amount').onBlur();
    vi.advanceTimersByTime(500); expect(onChange).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('Complete both amount and unit'); expect(html).not.toContain('All time');
  });
  it.each(['amount', 'unit'])('keeps a %s-only draft unapplied until both fields are complete', first => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const harness = controlHarness(() => PeriodFilter({ value: {}, onChange }));
    change(control(harness.render(), `Posted in last ${first}`), first === 'amount' ? '7' : 'days');
    const tree = harness.render();
    expect(renderToStaticMarkup(tree)).toContain('Complete both amount and unit');
    vi.advanceTimersByTime(500); expect(onChange).not.toHaveBeenCalled();
    change(control(tree, `Posted in last ${first === 'amount' ? 'unit' : 'amount'}`), first === 'amount' ? 'days' : '7');
    harness.render(); vi.advanceTimersByTime(350);
    expect(onChange).toHaveBeenCalledWith({ posted_amount: 7, posted_unit: 'days', from: undefined, to: undefined });
  });
});
