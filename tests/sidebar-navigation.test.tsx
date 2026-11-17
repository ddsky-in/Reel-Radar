import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Link from 'next/link';
import { App } from '../src/components/app';
import { Explorer } from '../src/components/explorer';
import { Carousels } from '../src/components/carousels';
import { KeywordFilter, ReelFilters } from '../src/components/reel-filters';
import { CarouselFilters } from '../src/components/carousel-filters';
import { createNavigationIntent, NavigationIntentContext, type NavigationIntentController } from '../src/lib/navigation-intent';

const fixture = vi.hoisted(() => ({
  hooks: null as null | {
    state: (initial: unknown) => unknown;
    ref: (initial: unknown) => unknown;
    effect: (callback: () => void | (() => void), dependencies?: readonly unknown[]) => void;
  },
  controller: null as NavigationIntentController | null,
  pathname: '/reels', params: new URLSearchParams(), linkPending: false,
  router: { replace: vi.fn(), push: vi.fn() },
}));
vi.mock('react', async original => {
  const react = await original<typeof import('react')>();
  return { ...react,
    useState: (initial: unknown) => fixture.hooks ? fixture.hooks.state(initial) : react.useState(initial),
    useRef: (initial: unknown) => fixture.hooks ? fixture.hooks.ref(initial) : react.useRef(initial),
    useEffect: (callback: () => void | (() => void), dependencies?: readonly unknown[]) => fixture.hooks ? fixture.hooks.effect(callback, dependencies) : react.useEffect(callback, dependencies),
    useContext: (context: unknown) => fixture.hooks && context === NavigationIntentContext ? fixture.controller : react.useContext(context as Parameters<typeof react.useContext>[0]),
    useSyncExternalStore: (subscribe: Parameters<typeof react.useSyncExternalStore>[0], snapshot: () => unknown, serverSnapshot?: () => unknown) => fixture.hooks ? snapshot() : react.useSyncExternalStore(subscribe, snapshot, serverSnapshot),
    useId: () => fixture.hooks ? 'fixture-keywords' : react.useId(),
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => fixture.router, usePathname: () => fixture.pathname, useSearchParams: () => fixture.params }));
vi.mock('next/link', () => ({ default: 'fixture-link', useLinkStatus: () => ({ pending: fixture.linkPending }) }));
vi.mock('@/lib/workspace-selection', async original => ({ ...await original<typeof import('../src/lib/workspace-selection')>(), useWorkspaceSelection: () => null }));
vi.mock('@/lib/use-resource', () => ({ useResource: (path: string | null) => ({
  data: path === '/api/bootstrap' ? null : path?.endsWith('/creator-directory') ? [] : { items: [], total: 0, page: 1, limit: 30 },
  error: null, loading: false, refreshing: false,
}) }));

// Same dependency-aware hook/event harness as the existing UI tests. The real
// Explorer/Carousels handlers and KeywordFilter effect run, not copied guards.
function harness<P>(component: (props: P) => ReactNode, props: P) {
  const slots: unknown[] = [];
  const effects: { dependencies?: readonly unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0, effectCursor = 0, dirty = false;
  let pending: (() => void)[] = [];
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
        effects[index] = { dependencies, cleanup: callback() || undefined };
      });
    },
  };
  return {
    render() {
      for (let iteration = 0; iteration < 20; iteration++) {
        cursor = 0; effectCursor = 0; dirty = false; pending = [];
        fixture.hooks = hooks;
        let tree: ReactNode;
        try { tree = component(props); } finally { fixture.hooks = null; }
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
function find(tree: ReactNode, predicate: (element: Element) => boolean) {
  const found = elements(tree).find(predicate);
  if (!found) throw new Error('Element not found');
  return found;
}
function sidebar(tree: ReactNode, href: string) { return find(tree, element => element.type === Link && element.props.href === href && String(element.props.className).includes('nav-link')); }
function changeFilter(element: Element, next: { keywords: string }) { (element.props.onChange as (next: { keywords: string }) => void)(next); }
function activate(link: Element, options: { button?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; target?: string; keyboard?: boolean } = {}) {
  // Link owns browser semantics; onNavigate is only called for same-window SPA
  // navigation (including Enter). App must not add a broad click/pointer guard.
  expect(link.props.onClick).toBeUndefined();
  if ((options.button ?? 0) !== 0 || options.ctrlKey || options.metaKey || options.shiftKey || options.altKey || options.target && options.target !== '_self') return;
  (link.props.onNavigate as () => void)();
  fixture.router.push(link.props.href);
}
const disposables: (() => void)[] = [];
function appHarness() {
  const app = harness(App, { section: 'reels' });
  const tree = app.render();
  const provider = find(tree, element => element.type === NavigationIntentContext.Provider);
  fixture.controller = provider.props.value as NavigationIntentController;
  disposables.push(app.dispose);
  return app;
}
function feedbackHarness(app: ReturnType<typeof appHarness>, href: string) {
  const link = sidebar(app.render(), href);
  const child = find(link.props.children as ReactNode, element => typeof element.type === 'function' && element.type.name === 'NavigationFeedback');
  const ui = harness(child.type as (props: Record<string, unknown>) => ReactNode, child.props);
  disposables.push(ui.dispose);
  return ui;
}
function researchHarness(carousels: boolean) {
  const ui = carousels ? harness(Carousels, { workspaceId: 'fixture', notify: () => {}, demo: true }) : harness(Explorer, { section: 'reels' as const, workspaceId: 'fixture', notify: () => {} });
  disposables.push(ui.dispose);
  return ui;
}
beforeEach(() => {
  vi.useFakeTimers();
  fixture.pathname = '/reels'; fixture.params = new URLSearchParams(); fixture.controller = null; fixture.linkPending = false;
  fixture.router.replace.mockReset(); fixture.router.push.mockReset();
  const target = new EventTarget();
  vi.stubGlobal('window', { location: { pathname: '/reels', search: '' }, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target) });
});
afterEach(() => { disposables.splice(0).forEach(dispose => dispose()); fixture.hooks = null; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('sidebar navigation intent beats outgoing debounced URL updates', () => {
  it.each([false, true])('suppresses a cold outgoing %s keyword callback before the destination commits', carousels => {
    if (carousels) { fixture.pathname = '/carousels'; window.location.pathname = '/carousels'; }
    const app = appHarness(), ui = researchHarness(carousels);
    const filter = find(ui.render(), element => element.type === (carousels ? CarouselFilters : ReelFilters));
    const keyword = harness(KeywordFilter, { value: '', onChange: (keywords: string) => changeFilter(filter, { keywords }) });
    disposables.push(keyword.dispose);
    const input = find(keyword.render(), element => element.type === 'input');
    (input.props.onChange as (event: unknown) => void)({ target: { value: 'late keyword' } });
    keyword.render();
    activate(sidebar(app.render(), '/creators'));
    expect(fixture.pathname).toBe(carousels ? '/carousels' : '/reels'); // genuinely cold/uncommitted
    vi.advanceTimersByTime(350);
    expect(fixture.router.push).toHaveBeenCalledWith('/creators');
    expect(fixture.router.replace).not.toHaveBeenCalled();
    // Intent changes only filter-control keys, cancelling queued drafts on the
    // next React commit; even an already queued old callback cannot replace.
    const next = find(ui.render(), element => element.type === filter.type);
    expect(next.key).not.toBe(filter.key);
    changeFilter(filter, { keywords: 'already queued' });
    expect(fixture.router.replace).not.toHaveBeenCalled();
    expect(sidebar(app.render(), '/creators').props['aria-busy']).toBe(true);
    expect(sidebar(app.render(), '/creators').props['aria-disabled']).toBeUndefined();
  });

  it('keeps only the newest rapid navigation intent even across intermediate commits', () => {
    const app = appHarness(), ui = researchHarness(false);
    const oldFilter = find(ui.render(), element => element.type === ReelFilters);
    activate(sidebar(app.render(), '/carousels'));
    const first = fixture.controller!.getPending()!;
    activate(sidebar(app.render(), '/creators'));
    const latest = fixture.controller!.getPending()!;
    fixture.controller!.finish(first.epoch);
    fixture.controller!.observe('/carousels', '/carousels');
    changeFilter(oldFilter, { keywords: 'stale' });
    expect(fixture.controller!.getPending()).toEqual(latest);
    expect(fixture.router.replace).not.toHaveBeenCalled();
    fixture.controller!.observe('/creators', '/creators');
    expect(fixture.controller!.getPending()).toBeNull();
    expect(fixture.router.push.mock.calls).toEqual([['/carousels'], ['/creators']]);
  });

  it.each([false, true])('keeps debounced filters working on the active %s page, including same-route params', carousels => {
    if (carousels) { fixture.pathname = '/carousels'; window.location.pathname = '/carousels'; }
    appHarness();
    const ui = researchHarness(carousels);
    const filter = find(ui.render(), element => element.type === (carousels ? CarouselFilters : ReelFilters));
    const keyword = harness(KeywordFilter, { value: '', onChange: (keywords: string) => changeFilter(filter, { keywords }) });
    disposables.push(keyword.dispose);
    (find(keyword.render(), element => element.type === 'input').props.onChange as (event: unknown) => void)({ target: { value: 'current' } });
    keyword.render();
    vi.advanceTimersByTime(349); expect(fixture.router.replace).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fixture.router.replace).toHaveBeenCalledWith(expect.stringContaining('keywords=current'), { scroll: false });
    const epoch = fixture.controller!.getSnapshot();
    fixture.controller!.observe(fixture.pathname, fixture.pathname + '?keywords=current');
    expect(fixture.controller!.getSnapshot()).toBe(epoch); // query commits don't reset controls
    changeFilter(filter, { keywords: 'next' });
    expect(fixture.router.replace).toHaveBeenLastCalledWith(expect.stringContaining('keywords=next'), { scroll: false });
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { target: '_blank' }])('preserves new-tab/window semantics without suppressing current filters: %j', options => {
    const app = appHarness(), ui = researchHarness(false);
    const filter = find(ui.render(), element => element.type === ReelFilters);
    const before = fixture.controller!.getSnapshot();
    activate(sidebar(app.render(), '/creators'), options);
    expect(fixture.controller!.getSnapshot()).toBe(before);
    expect(fixture.router.push).not.toHaveBeenCalled();
    changeFilter(filter, { keywords: 'still here' });
    expect(fixture.router.replace).toHaveBeenCalledOnce();
  });

  it('closes mobile navigation for keyboard link activation and guards browser back before pathname commits', () => {
    const app = appHarness(), ui = researchHarness(false);
    const oldFilter = find(ui.render(), element => element.type === ReelFilters);
    (find(app.render(), element => element.type === 'button' && element.props['aria-label'] === 'Open navigation').props.onClick as () => void)();
    expect(find(app.render(), element => element.type === 'aside').props.className).toContain('sidebar-open');
    activate(sidebar(app.render(), '/creators'), { keyboard: true });
    expect(find(app.render(), element => element.type === 'aside').props.className).not.toContain('sidebar-open');
    window.location.pathname = '/dashboard';
    window.dispatchEvent(new Event('popstate'));
    expect(fixture.pathname).toBe('/reels');
    expect(fixture.controller!.getPending()?.href).toBe('/dashboard');
    changeFilter(oldFilter, { keywords: 'back race' });
    expect(fixture.router.replace).not.toHaveBeenCalled();
  });

  it.each([false, true])('drops the parent optimistic %s draft on same-page clean navigation and rapid back', carousels => {
    if (carousels) { fixture.pathname = '/carousels'; window.location.pathname = '/carousels'; }
    const app = appHarness(), ui = researchHarness(carousels);
    const filterType = carousels ? CarouselFilters : ReelFilters;
    const filter = find(ui.render(), element => element.type === filterType);
    changeFilter(filter, { keywords: 'committed draft' });
    expect(find(ui.render(), element => element.type === filterType).props.value).toMatchObject({ keywords: 'committed draft' });
    const committedHref = fixture.router.replace.mock.lastCall![0] as string;
    fixture.params = new URL(committedHref, 'http://fixture.invalid').searchParams;
    window.location.search = '?' + fixture.params.toString();
    app.render();
    expect(find(ui.render(), element => element.type === filterType).props.value).toMatchObject({ keywords: 'committed draft' });
    expect(text(ui.render())).toContain(' · filtered');

    const committedEpoch = fixture.controller!.getSnapshot();
    activate(sidebar(app.render(), fixture.pathname));
    expect(fixture.controller!.getSnapshot()).toBeGreaterThan(committedEpoch);
    fixture.params = new URLSearchParams(); window.location.search = '';
    app.render();
    let cleanTree = ui.render();
    expect((find(cleanTree, element => element.type === filterType).props.value as { keywords?: string }).keywords).toBeUndefined();
    expect(text(cleanTree)).not.toContain(' · filtered');
    expect(fixture.controller!.getPending()).toBeNull();

    // Stay on the same mounted parent: rapid away intent followed by browser
    // back to the clean source must not resurrect its old optimistic draft.
    activate(sidebar(app.render(), '/creators'));
    window.dispatchEvent(new Event('popstate'));
    cleanTree = ui.render();
    expect((find(cleanTree, element => element.type === filterType).props.value as { keywords?: string }).keywords).toBeUndefined();
    expect(text(cleanTree)).not.toContain(' · filtered');
    const cleanFilter = find(cleanTree, element => element.type === filterType);
    changeFilter(cleanFilter, { keywords: 'fresh query' });
    expect(fixture.router.replace).toHaveBeenLastCalledWith(expect.stringContaining('keywords=fresh+query'), { scroll: false });
  });

  it.each([false, true])('settles normalized popstate query targets without releasing stale %s filter leases', carousels => {
    if (carousels) { fixture.pathname = '/carousels'; window.location.pathname = '/carousels'; }
    const app = appHarness(), ui = researchHarness(carousels);
    const oldFilter = find(ui.render(), element => element.type === (carousels ? CarouselFilters : ReelFilters));
    window.location.search = '?keywords=AI%20tools';
    window.dispatchEvent(new Event('popstate'));
    expect(fixture.controller!.getPending()?.href).toBe(fixture.pathname + '?keywords=AI+tools');
    changeFilter(oldFilter, { keywords: 'late callback' });
    expect(fixture.router.replace).not.toHaveBeenCalled();
    fixture.params = new URLSearchParams(window.location.search);
    app.render();
    expect(fixture.controller!.getPending()).toBeNull();
    changeFilter(oldFilter, { keywords: 'stale after commit' });
    expect(fixture.router.replace).not.toHaveBeenCalled();
    const currentFilter = find(ui.render(), element => element.type === oldFilter.type);
    changeFilter(currentFilter, { keywords: 'fresh' });
    expect(fixture.router.replace).toHaveBeenCalledOnce();
  });

  it.each([false, true])('runs the feedback child through pending/history/route-commit lifecycle (query-only: %s)', queryOnly => {
    if (queryOnly) { fixture.params = new URLSearchParams('keywords=old'); window.location.search = '?keywords=old'; }
    const app = appHarness(), ui = researchHarness(false);
    const oldFilter = find(ui.render(), element => element.type === ReelFilters);
    const href = queryOnly ? '/reels' : '/creators';
    const feedback = feedbackHarness(app, href);
    expect(feedback.render()).toBeNull();
    activate(sidebar(app.render(), href));
    fixture.linkPending = true;
    expect(find(feedback.render(), element => element.props['aria-label'] === 'Opening page')).toBeDefined();
    window.location.pathname = href; window.location.search = '';
    fixture.linkPending = false;
    feedback.render(); // Next says history updated, but route hooks still describe the source.
    expect(fixture.controller!.getPending()?.href).toBe(href);
    expect(sidebar(app.render(), href).props['aria-busy']).toBe(true);
    changeFilter(find(ui.render(), element => element.type === ReelFilters), { keywords: 'history race' });
    expect(fixture.router.replace).not.toHaveBeenCalled();
    fixture.pathname = href; fixture.params = new URLSearchParams();
    app.render();
    expect(feedback.render()).toBeNull();
    expect(fixture.controller!.getPending()).toBeNull();
    expect(sidebar(app.render(), href).props['aria-busy']).toBeUndefined();
    changeFilter(oldFilter, { keywords: 'stale after destination commit' });
    expect(fixture.router.replace).not.toHaveBeenCalled();
  });

  it('runs skipped-pending feedback and waits for the prefetched route commit', () => {
    const app = appHarness(), feedback = feedbackHarness(app, '/creators');
    feedback.render(); activate(sidebar(app.render(), '/creators'));
    window.location.pathname = '/creators';
    feedback.render();
    expect(fixture.controller!.getPending()?.href).toBe('/creators');
    fixture.pathname = '/creators'; app.render();
    expect(feedback.render()).toBeNull();
  });

  it('cancels feedback only at the observed source and never releases a newer rapid intent', () => {
    const app = appHarness(), first = feedbackHarness(app, '/carousels'), latest = feedbackHarness(app, '/creators');
    activate(sidebar(app.render(), '/carousels')); fixture.linkPending = true; first.render();
    activate(sidebar(app.render(), '/creators')); latest.render();
    const intent = fixture.controller!.getPending();
    fixture.linkPending = false; first.render();
    expect(fixture.controller!.getPending()).toEqual(intent);
    latest.render(); // cancelled navigation: browser and observed route still at /reels
    expect(fixture.controller!.getPending()).toBeNull();
    expect(first.render()).toBeNull(); expect(latest.render()).toBeNull();
  });

  it('does not treat an intermediate route commit as cancellation of newer Link feedback', () => {
    const app = appHarness(), feedback = feedbackHarness(app, '/creators');
    feedback.render();
    activate(sidebar(app.render(), '/carousels'));
    activate(sidebar(app.render(), '/creators'));
    fixture.linkPending = true; feedback.render();
    const latest = fixture.controller!.getPending();
    window.location.pathname = '/carousels'; fixture.pathname = '/carousels'; app.render();
    fixture.linkPending = false; feedback.render();
    expect(fixture.controller!.getPending()).toEqual(latest);
    expect(sidebar(app.render(), '/creators').props['aria-busy']).toBe(true);
    window.location.pathname = '/creators'; fixture.pathname = '/creators'; app.render();
    expect(feedback.render()).toBeNull();
    expect(fixture.controller!.getPending()).toBeNull();
  });

  it('hides closed mobile navigation from keyboard focus and returns focus on dismissal', () => {
    const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
    expect(css).toMatch(/@media \(max-width: 1100px\)\s*\{\s*\.sidebar \{[^}]*visibility: hidden/);
    expect(css).toMatch(/\.sidebar-open \{[^}]*visibility: visible/);
    const app = appHarness();
    const menu = () => find(app.render(), element => element.type === 'button' && element.props['aria-label'] === 'Open navigation');
    const focus = vi.fn();
    (menu().props.ref as { current: unknown }).current = { focus };
    for (const dismissal of ['close', 'escape', 'backdrop']) {
      (menu().props.onClick as () => void)();
      expect(menu().props['aria-expanded']).toBe(true);
      const tree = app.render();
      if (dismissal === 'close') (find(tree, element => element.props['aria-label'] === 'Close navigation').props.onClick as () => void)();
      else if (dismissal === 'backdrop') (find(tree, element => element.props.className === 'sidebar-backdrop').props.onClick as () => void)();
      else {
        const preventDefault = vi.fn();
        (find(tree, element => element.type === 'aside').props.onKeyDown as (event: unknown) => void)({ key: 'Escape', preventDefault });
        expect(preventDefault).toHaveBeenCalledOnce();
      }
      expect(menu().props['aria-expanded']).toBe(false);
      expect(find(app.render(), element => element.type === 'aside').props.id).toBe(menu().props['aria-controls']);
    }
    expect(focus).toHaveBeenCalledTimes(3);
  });

  it('cleans up same-route parameter intents and failed transitions without reviving old leases', () => {
    const controller = createNavigationIntent('/reels', '/reels?keywords=old');
    const original = controller.getSnapshot();
    controller.begin('/reels');
    expect(controller.canCommit('/reels', original)).toBe(false);
    controller.observe('/reels', '/reels');
    expect(controller.getPending()).toBeNull();
    const failed = controller.begin('/creators');
    controller.finish(failed);
    expect(controller.getPending()).toBeNull();
    expect(controller.canCommit('/reels', original)).toBe(false);
    expect(controller.canCommit('/reels', controller.getSnapshot())).toBe(true);
  });
});
