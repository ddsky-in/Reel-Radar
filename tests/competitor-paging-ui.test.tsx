import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Competitors } from '../src/components/competitors';
import { RemoveCompetitors } from '../src/components/remove-competitors';
import { ErrorState } from '../src/components/ui';
import { ReelPagination } from '../src/components/reel-filters';
import type { BulkRemoveCreatorsResult, Creator, CreatorCollectionSummary, CreatorDirectoryEntry, PageResult } from '../src/lib/types';
import type { ResourceState } from '../src/lib/resource-cache';

const fixtures = vi.hoisted(() => ({
  hooks: null as null | {
    state: (initial: unknown) => unknown;
    effect: (callback: () => void | (() => void), dependencies?: readonly unknown[]) => void;
    ref: (initial: unknown) => unknown;
  },
  creators: [] as Creator[],
  directory: null as ResourceState<CreatorDirectoryEntry[]> | null,
  summary: { data: { reason: null, blocking_job_id: null, pending_jobs: 0, active_jobs: 0 }, error: null, loading: false, refreshing: false } as ResourceState<CreatorCollectionSummary>,
  pages: new Map<string, ResourceState<PageResult<Creator>>>(),
  paths: [] as string[],
  invalidate: vi.fn(),
  api: vi.fn(),
}));

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (initial: unknown) => fixtures.hooks ? fixtures.hooks.state(initial) : react.useState(initial),
    useEffect: (callback: () => void | (() => void), dependencies?: readonly unknown[]) => fixtures.hooks ? fixtures.hooks.effect(callback, dependencies) : react.useEffect(callback, dependencies),
    useRef: (initial: unknown) => fixtures.hooks ? fixtures.hooks.ref(initial) : react.useRef(initial),
  };
});
vi.mock('@/lib/resource-cache', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/resource-cache')>(), invalidateResources: fixtures.invalidate }));
vi.mock('@/lib/client', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/client')>(), api: fixtures.api }));
vi.mock('@/lib/use-resource', () => ({ useResource: (path: string | null) => {
  if (!path) return ready(null);
  fixtures.paths.push(path);
  if (path.endsWith('/creator-directory')) return fixtures.directory ?? ready(fixtures.creators.map(entry));
  if (path.endsWith('/collection-summary')) return fixtures.summary;
  if (path.includes('/competitors?')) {
    const params = new URL(path, 'http://fixture.invalid').searchParams;
    const page = Number(params.get('page')), search = params.get('search')?.toLowerCase() ?? '';
    const filtered = fixtures.creators.filter(creator => `${creator.username} ${creator.display_name ?? ''}`.toLowerCase().includes(search));
    return fixtures.pages.get(path) ?? ready({ items: filtered.slice((page - 1) * 50, page * 50), total: filtered.length, page, limit: 50 } satisfies PageResult<Creator>);
  }
  throw new Error(`Unexpected resource path: ${path}`);
} }));

function ready<T>(data: T): ResourceState<T> { return { data, error: null, loading: false, refreshing: false }; }
function entry({ id, username, display_name, avatar_url, status }: Creator): CreatorDirectoryEntry { return { id, username, display_name, avatar_url, status }; }
function creators(count: number): Creator[] {
  return Array.from({ length: count }, (_, i) => ({ id: `creator-${i + 1}`, username: `synthetic_${i + 1}`, display_name: `Synthetic ${i + 1}`, avatar_url: null, status: 'active', followers_count: null, last_profile_fetch_at: null, last_reels_fetch_at: null, last_error: null }));
}

// Deterministic component hook/event runner: executes the real JSX event handlers
// and dependency-aware effects without introducing a DOM/renderer dependency.
function harness<P>(component: (props: P) => ReactNode, props: P) {
  const slots: unknown[] = [];
  const effects: { dependencies?: readonly unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0, effectCursor = 0, dirty = false;
  let pending: (() => void)[] = [];
  let tree: ReactNode;
  const hooks = {
    state(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next: unknown) => {
        const value = typeof next === 'function' ? next(slots[index]) : next;
        if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true; }
      }];
    },
    ref(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    effect(callback: () => void | (() => void), dependencies?: readonly unknown[]) {
      const index = effectCursor++, previous = effects[index];
      if (previous && dependencies && previous.dependencies && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies![i]))) return;
      pending.push(() => {
        previous?.cleanup?.();
        const cleanup = callback();
        effects[index] = { dependencies, cleanup: cleanup || undefined };
      });
    },
  };
  return {
    render() {
      for (let iteration = 0; iteration < 20; iteration++) {
        dirty = false; cursor = 0; effectCursor = 0; pending = [];
        fixtures.hooks = hooks;
        try { tree = component(props); } finally { fixtures.hooks = null; }
        pending.forEach(effect => effect());
        if (!dirty) return tree;
      }
      throw new Error('Component did not settle');
    },
    dispose() { effects.forEach(effect => effect.cleanup?.()); },
  };
}

type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...elements(tree.props.children as ReactNode)];
}
function text(tree: ReactNode): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join('');
  return isValidElement<Record<string, unknown>>(tree) ? text(tree.props.children as ReactNode) : '';
}
function find(tree: ReactNode, predicate: (element: Element) => boolean): Element {
  const result = elements(tree).find(predicate);
  if (!result) throw new Error(`Element not found in ${text(tree)}`);
  return result;
}
function button(tree: ReactNode, label: string): Element { return find(tree, element => element.type === 'button' && text(element) === label); }
function click(element: Element) {
  expect(element.props.disabled).not.toBe(true);
  (element.props.onClick as () => unknown)();
}
function checkbox(tree: ReactNode, label: string, checked: boolean) {
  const input = find(tree, element => element.type === 'input' && element.props['aria-label'] === label);
  (input.props.onChange as (event: unknown) => void)({ target: { checked } });
}
function pagination(tree: ReactNode) { return find(tree, element => element.type === ReelPagination); }
function goPage(tree: ReactNode, page: number) { (pagination(tree).props.onPage as (page: number) => void)(page); }
function search(tree: ReactNode, value: string) {
  const input = find(tree, element => element.type === 'input' && element.props['aria-label'] === 'Search competitors');
  (input.props.onChange as (event: unknown) => void)({ target: { value } });
}
const base = '/api/workspaces/fixture-workspace';
function listPath(page = 1, query = '') { return `${base}/competitors?${new URLSearchParams({ search: query, page: String(page), limit: '50' })}`; }
const refresh = vi.fn(async () => {}), notify = vi.fn();
function competitorsHarness() { return harness(Competitors, { workspaceId: 'fixture-workspace', workspaceName: 'Synthetic workspace', refresh, notify }); }

beforeEach(() => {
  vi.useFakeTimers();
  fixtures.creators = creators(151); fixtures.directory = null; fixtures.pages.clear(); fixtures.paths = [];
  fixtures.summary = ready({ reason: null, blocking_job_id: null, pending_jobs: 0, active_jobs: 0 });
  fixtures.invalidate.mockReset(); fixtures.api.mockReset(); refresh.mockClear(); notify.mockClear();
});
afterEach(() => { fixtures.hooks = null; vi.useRealTimers(); });

describe('paged competitor interactions', () => {
  it('links full stored carousel counts on every page without extra resource reads', () => {
    fixtures.creators[0].tracked_carousels = 63;
    fixtures.creators[1].tracked_carousels = 0;
    fixtures.creators[50].tracked_carousels = 1250;
    const ui = competitorsHarness();
    let tree = ui.render();
    expect(elements(tree).filter(element => element.type === 'th').map(text)).toEqual(['', 'Creator', 'Followers', 'Reels', 'Carousels', 'Last fetch', 'Status', 'Actions']);
    const count = find(tree, element => element.props['aria-label'] === 'View 63 stored carousels for @synthetic_1');
    expect(count.props.href).toBe('/carousels?creator=creator-1');
    expect(text(count)).toBe('63');
    expect(text(find(tree, element => element.props['aria-label'] === 'View 0 stored carousels for @synthetic_2'))).toBe('0');
    expect(text(tree)).toContain('Carousel count unavailable for @synthetic_3');
    goPage(tree, 2); tree = ui.render();
    const later = find(tree, element => element.props['aria-label'] === 'View 1,250 stored carousels for @synthetic_51');
    expect(later.props.href).toBe('/carousels?creator=creator-51');
    expect(text(later)).toBe('1,250');
    expect(new Set(fixtures.paths)).toEqual(new Set([listPath(), listPath(2), `${base}/creator-directory`, `${base}/collection-summary`]));
    ui.dispose();
  });
  it.each([false, true])('retries only the current exact paged list after %s last-good data', cached => {
    const ui = competitorsHarness();
    let tree = ui.render(); vi.advanceTimersByTime(350);
    goPage(tree, 2); tree = ui.render();
    search(tree, ' synthetic_ '); ui.render(); vi.advanceTimersByTime(350); tree = ui.render();
    goPage(tree, 2); tree = ui.render();
    const path = listPath(2, 'synthetic_');
    fixtures.pages.set(path, { ...ready(cached ? { items: fixtures.creators.slice(50, 100), total: 151, page: 2, limit: 50 } : null), error: 'List read failed' });
    tree = ui.render();
    if (cached) click(button(tree, 'Retry'));
    else (find(tree, element => element.type === ErrorState).props.retry as () => void)();
    expect(fixtures.invalidate.mock.calls).toEqual([[path]]);
    expect(fixtures.paths).not.toContain(`${base}/collection-status`);
    ui.dispose();
  });

  it('targets directory and collection-summary retries independently, keeping saved rows', () => {
    const ui = competitorsHarness();
    fixtures.directory = { ...ready(null), error: 'Directory read failed' };
    fixtures.summary = { ...ready(null), error: 'Summary read failed' };
    const tree = ui.render();
    expect(text(tree)).toContain('Competitor directory unavailable. Your selection is preserved.');
    expect(elements(tree).filter(element => element.type === 'tr')).toHaveLength(51);
    click(button(tree, 'Retry competitor directory'));
    expect(fixtures.invalidate.mock.calls).toEqual([[`${base}/creator-directory`]]);
    click(button(tree, 'Retry status check'));
    expect(fixtures.invalidate.mock.calls).toEqual([[`${base}/creator-directory`], [`${base}/collection-summary`]]);
    ui.dispose();
  });

  it('preserves selected IDs and identity metadata across pages, search, loading and failures', () => {
    const ui = competitorsHarness();
    let tree = ui.render(); vi.advanceTimersByTime(350);
    checkbox(tree, 'Select synthetic_1', true); tree = ui.render();
    goPage(tree, 2); tree = ui.render();
    checkbox(tree, 'Select synthetic_51', true); tree = ui.render();
    expect(text(tree)).toContain('2 selected · 1 outside this page');
    search(tree, 'Synthetic 151'); ui.render(); vi.advanceTimersByTime(350); tree = ui.render();
    expect(text(tree)).toContain('2 selected · 2 outside this page');
    const path = listPath(1, 'Synthetic 151');
    fixtures.pages.set(path, { ...ready(null), loading: true });
    fixtures.directory = { ...ready([]), refreshing: true };
    tree = ui.render();
    expect(text(tree)).toContain('2 selected');
    fixtures.pages.set(path, { ...ready(null), error: 'Read failed' });
    fixtures.directory = { ...ready([]), error: 'Metadata read failed' };
    tree = ui.render();
    expect(text(tree)).toContain('2 selected');
    click(button(tree, 'Refresh 2 selected'));
    expect(refresh).toHaveBeenCalledWith(['creator-1', 'creator-51']);
    click(button(tree, 'Delete selected (2)')); tree = ui.render();
    const removal = find(tree, element => element.type === RemoveCompetitors);
    expect(removal.props.creators).toEqual([entry(fixtures.creators[0]), entry(fixtures.creators[50])]);
    (removal.props.close as () => void)();
    fixtures.directory = ready(fixtures.creators.filter(creator => creator.id !== 'creator-1').map(entry));
    fixtures.pages.delete(path); tree = ui.render();
    expect(text(tree)).toContain('1 selected · 1 outside this page');
    // A later successful directory reappearance must not resurrect an ID that
    // was authoritatively removed from selection.
    fixtures.directory = ready(fixtures.creators.map(entry)); tree = ui.render();
    expect(text(tree)).toContain('1 selected · 1 outside this page');
    click(button(tree, 'Clear selection')); tree = ui.render();
    expect(text(tree)).not.toContain('selected');
    ui.dispose();
  });

  it('retains the latest successful selected metadata when the directory subsequently fails', () => {
    const ui = competitorsHarness();
    let tree = ui.render();
    checkbox(tree, 'Select synthetic_1', true); tree = ui.render();
    const updated = { ...entry(fixtures.creators[0]), username: 'synthetic_updated', display_name: 'Synthetic updated name' };
    fixtures.directory = ready([updated, ...fixtures.creators.slice(1).map(entry)]); tree = ui.render();
    fixtures.directory = { ...ready(null), error: 'Directory read failed' }; tree = ui.render();
    click(button(tree, 'Delete selected (1)')); tree = ui.render();
    expect(find(tree, element => element.type === RemoveCompetitors).props.creators).toEqual([updated]);
    ui.dispose();
  });

  it('selects/deselects only visible rows and exposes the 120-ID refresh limit without truncation', () => {
    const ui = competitorsHarness();
    let tree = ui.render(); vi.advanceTimersByTime(350);
    checkbox(tree, 'Select all visible competitors', true); tree = ui.render();
    goPage(tree, 2); tree = ui.render(); checkbox(tree, 'Select all visible competitors', true); tree = ui.render();
    goPage(tree, 3); tree = ui.render();
    for (let i = 101; i <= 120; i++) { checkbox(tree, `Select synthetic_${i}`, true); tree = ui.render(); }
    click(button(tree, 'Refresh 120 selected'));
    expect(refresh).toHaveBeenLastCalledWith(fixtures.creators.slice(0, 120).map(creator => creator.id));
    checkbox(tree, 'Select synthetic_121', true); tree = ui.render();
    expect(button(tree, 'Refresh 121 selected').props).toMatchObject({ disabled: true, title: 'Refresh supports up to 120 selected competitors at once.' });
    click(button(tree, 'Delete selected (121)')); tree = ui.render();
    const removal = find(tree, element => element.type === RemoveCompetitors);
    expect(removal.props.creators).toHaveLength(121);
    (removal.props.close as () => void)(); tree = ui.render();
    checkbox(tree, 'Select all visible competitors', false); tree = ui.render();
    expect(text(tree)).toContain('100 selected · 100 outside this page');
    goPage(tree, 1); tree = ui.render();
    expect(find(tree, element => element.props['aria-label'] === 'Select all visible competitors').props.checked).toBe(true);
    ui.dispose();
  });

  it('does not move a populated valid page after an equally-sized off-page selection is deleted', () => {
    const ui = competitorsHarness();
    let tree = ui.render(); vi.advanceTimersByTime(350);
    checkbox(tree, 'Select all visible competitors', true); tree = ui.render();
    goPage(tree, 2); tree = ui.render();
    click(button(tree, 'Delete selected (50)')); tree = ui.render();
    const removal = find(tree, element => element.type === RemoveCompetitors);
    (removal.props.removed as (ids: string[]) => void)(fixtures.creators.slice(0, 50).map(creator => creator.id));
    (removal.props.close as () => void)();
    // Until the post-mutation list arrives, the original visible page stays put.
    tree = ui.render();
    expect(pagination(tree).props.page).toBe(2);
    expect(elements(tree).filter(element => element.type === 'tr')).toHaveLength(51);
    fixtures.creators = fixtures.creators.slice(50); tree = ui.render();
    expect(pagination(tree).props.page).toBe(2);
    expect(pagination(tree).props.total).toBe(101);
    expect(elements(tree).filter(element => element.type === 'tr')).toHaveLength(51);
    expect(fixtures.invalidate).not.toHaveBeenCalled();
    ui.dispose();
  });

  it('clamps from the refreshed filtered total even when deletion leaves some visible rows', () => {
    fixtures.creators = creators(101);
    const ui = competitorsHarness();
    let tree = ui.render(); vi.advanceTimersByTime(350);
    checkbox(tree, 'Select all visible competitors', true); tree = ui.render();
    goPage(tree, 3); tree = ui.render();
    click(button(tree, 'Delete selected (50)')); tree = ui.render();
    const removal = find(tree, element => element.type === RemoveCompetitors);
    (removal.props.removed as (ids: string[]) => void)(fixtures.creators.slice(0, 50).map(creator => creator.id));
    (removal.props.close as () => void)();
    const refreshed: PageResult<Creator> = { items: [fixtures.creators[100]], total: 51, page: 3, limit: 50 };
    fixtures.pages.set(listPath(3), { ...ready(refreshed), refreshing: true }); tree = ui.render();
    expect(pagination(tree).props.page).toBe(3);
    fixtures.pages.set(listPath(3), { ...ready(refreshed), error: 'Update failed' }); tree = ui.render();
    expect(pagination(tree).props.page).toBe(3);
    fixtures.creators = fixtures.creators.slice(50);
    fixtures.pages.set(listPath(3), ready(refreshed)); tree = ui.render();
    expect(pagination(tree).props.page).toBe(2);
    expect(fixtures.paths).toContain(listPath(2));
    expect(pagination(tree).props.total).toBe(51);
    ui.dispose();
  });

  it.each([1, 0])('returns from an emptied final page to a valid page for %s remaining creators', total => {
    fixtures.creators = creators(101);
    const ui = competitorsHarness();
    let tree = ui.render(); vi.advanceTimersByTime(350);
    checkbox(tree, 'Select all visible competitors', true); tree = ui.render();
    goPage(tree, 2); tree = ui.render(); checkbox(tree, 'Select all visible competitors', true); tree = ui.render();
    goPage(tree, 3); tree = ui.render();
    if (!total) { checkbox(tree, 'Select all visible competitors', true); tree = ui.render(); }
    const count = 101 - total;
    click(button(tree, `Delete selected (${count})`)); tree = ui.render();
    const removal = find(tree, element => element.type === RemoveCompetitors);
    (removal.props.removed as (ids: string[]) => void)(fixtures.creators.slice(0, count).map(creator => creator.id));
    (removal.props.close as () => void)();
    fixtures.creators = fixtures.creators.slice(count);
    tree = ui.render();
    expect(pagination(tree).props.page).toBe(1);
    expect(pagination(tree).props.total).toBe(total);
    ui.dispose();
  });

  it('retries only failed deletion IDs while removing completed/already-removed selection IDs', async () => {
    fixtures.creators = creators(3);
    const ui = competitorsHarness();
    let tree = ui.render(); checkbox(tree, 'Select all visible competitors', true); tree = ui.render();
    click(button(tree, 'Delete selected (3)')); tree = ui.render();
    const removal = find(tree, element => element.type === RemoveCompetitors);
    const dialog = harness(RemoveCompetitors, removal.props as Parameters<typeof RemoveCompetitors>[0]);
    let dialogTree = dialog.render();
    fixtures.api.mockResolvedValueOnce({ removed_ids: ['creator-1'], already_removed_ids: ['creator-3'], failed: [{ creator_id: 'creator-2', error: { code: 'RETRY', message: 'Try again.' } }] } satisfies BulkRemoveCreatorsResult);
    await (button(dialogTree, 'Delete 3 competitors').props.onClick as () => Promise<void>)();
    dialogTree = dialog.render(); tree = ui.render();
    expect(text(tree)).toContain('1 selected');
    expect(text(dialogTree)).toContain('Retry to delete the remaining selection.');
    expect(text(dialogTree)).toContain('@synthetic_2');
    expect(text(dialogTree)).not.toContain('@synthetic_1'); expect(text(dialogTree)).not.toContain('@synthetic_3');
    fixtures.api.mockResolvedValueOnce({ removed_ids: ['creator-2'], already_removed_ids: [], failed: [] } satisfies BulkRemoveCreatorsResult);
    await (button(dialogTree, 'Retry: delete 1 competitor').props.onClick as () => Promise<void>)();
    tree = ui.render();
    expect(fixtures.api.mock.calls.map(([path, init]) => [path, JSON.parse(init.body)])).toEqual([
      [`${base}/creators`, { creator_ids: ['creator-1', 'creator-2', 'creator-3'] }],
      [`${base}/creators`, { creator_ids: ['creator-2'] }],
    ]);
    expect(elements(tree).some(element => element.type === RemoveCompetitors)).toBe(false);
    expect(text(tree)).not.toContain('selected');
    dialog.dispose(); ui.dispose();
  });
});
