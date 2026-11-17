import { isValidElement, type EffectCallback, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/components/app';
import { Jobs, Settings } from '../src/components/operations';
import { Workspaces } from '../src/components/workspaces';
import { CreatorSourceRefresh } from '../src/components/creator-source-refresh';
import { ReelDetailDialog } from '../src/components/reel-detail';
import { TranscriptViewer } from '../src/components/transcript-viewer';
import { createDemoData } from '../src/lib/demo';
import { clearResourceCache, getResourceSnapshot, invalidateResources, subscribeResource } from '../src/lib/resource-cache';
import type { Bootstrap, CreatorSourceRefresh as SourceReport, ReelDetail, TranscriptOverview, Workspace } from '../src/lib/types';

// Drive the real resource hook, cache subscriptions and API mutations without a DOM dependency.
// Components stay mounted across renders so a revision bump can dirty an in-flight refresh.
type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type HookState = { slots: Slot[]; cursor: number; effects: (() => void)[] };
const hooks = vi.hoisted(() => ({ active: null as HookState | null, router: { push: vi.fn(), replace: vi.fn() }, params: new URLSearchParams(), pathname: '/settings' }));
vi.mock('next/navigation', () => ({ useRouter: () => hooks.router, useSearchParams: () => hooks.params, usePathname: () => hooks.pathname }));
vi.mock('../src/lib/supabase/realtime', () => ({ startAppSync: () => () => {} }));
vi.mock('../src/lib/reel-save', () => ({ useReelSavePending: () => false, saveReel: vi.fn() }));
vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  function slot() {
    const active = hooks.active!;
    return active.slots[active.cursor++] ??= {};
  }
  function changed(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined) {
    return !previous || !next || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
  }
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!hooks.active) return react.useState(initial);
      const current = slot();
      if (!Object.hasOwn(current, 'value')) current.value = typeof initial === 'function' ? initial() : initial;
      return [current.value, (next: unknown) => { current.value = typeof next === 'function' ? next(current.value) : next; }];
    },
    useRef: (initial: unknown) => {
      if (!hooks.active) return react.useRef(initial);
      const current = slot();
      return current.value ??= { current: initial };
    },
    useCallback: (callback: unknown, deps: readonly unknown[]) => {
      if (!hooks.active) return react.useCallback(callback as () => void, deps);
      const current = slot();
      if (changed(current.deps, deps)) { current.value = callback; current.deps = deps; }
      return current.value;
    },
    useEffect: (effect: EffectCallback, deps?: readonly unknown[]) => {
      if (!hooks.active) return react.useEffect(effect, deps);
      const current = slot();
      if (changed(current.deps, deps)) {
        hooks.active.effects.push(() => { current.cleanup?.(); current.cleanup = effect() || undefined; });
        current.deps = deps;
      }
    },
    useSyncExternalStore: (subscribe: (listener: () => void) => () => void, snapshot: () => unknown, serverSnapshot?: () => unknown) => {
      if (!hooks.active) return react.useSyncExternalStore(subscribe, snapshot, serverSnapshot);
      const current = slot();
      if (current.value !== subscribe) { current.cleanup?.(); current.cleanup = subscribe(() => {}); current.value = subscribe; }
      return snapshot();
    },
  };
});

const cleanups: (() => void)[] = [];
function harness(renderComponent: () => ReactNode) {
  const state: HookState = { slots: [], cursor: 0, effects: [] };
  cleanups.push(() => state.slots.forEach(slot => slot.cleanup?.()));
  return { render() {
    state.cursor = 0; state.effects = []; hooks.active = state;
    let tree: ReactNode;
    try { tree = renderComponent(); } finally { hooks.active = null; }
    state.effects.forEach(effect => effect());
    return tree;
  } };
}

type Props = Record<string, unknown> & { children?: ReactNode; onClick?: () => void | Promise<void>; onSubmit?: (event: unknown) => Promise<void>; onChange?: (event: unknown) => void; onToggle?: (event: { currentTarget: { open: boolean } }) => void };
function find(tree: ReactNode, predicate: (element: ReactElement<Props>) => boolean): ReactElement<Props> {
  if (Array.isArray(tree)) {
    for (const child of tree) { try { return find(child, predicate); } catch { /* Search siblings. */ } }
  } else if (isValidElement<Props>(tree)) {
    if (predicate(tree)) return tree;
    if (tree.props.children) return find(tree.props.children, predicate);
  }
  throw new Error('Expected control not found');
}
function byLabel(tree: ReactNode, label: string) { return find(tree, element => element.props['aria-label'] === label); }
function byText(tree: ReactNode, text: string) { return find(tree, element => element.props.children === text || Array.isArray(element.props.children) && element.props.children.includes(text)); }
function nested(tree: ReactNode, name: string) { return find(tree, element => typeof element.type === 'function' && element.type.name === name); }
function childHarness(element: ReactElement<Props>) { return harness(() => (element.type as (props: Props) => ReactNode)(element.props)); }
function change(element: ReactElement<Props>, value: string) { element.props.onChange!({ target: { value } }); }
function submit(element: ReactElement<Props>) { return element.props.onSubmit!({ preventDefault: vi.fn(), currentTarget: { reportValidity: () => true } }); }
async function flush() { for (let index = 0; index < 15; index++) await Promise.resolve(); }
function observe(path: string) { cleanups.push(subscribeResource(path, () => {})); }

const demo = createDemoData();
const workspace = demo.workspaces[0];
const bootstrap: Bootstrap = { mode: 'supabase', email: 'request-owner@example.invalid', workspaces: [workspace], settings: { ...demo.settings }, usage: { estimated_month_spend: 0, actual_month_spend: null, reserved_usd: 0, unreconciled_jobs: 0, remaining_allowance: 4, provider_balance_usd: null }, jobs: [] };
const overview: TranscriptOverview = { enabled: true, paused: false, monthly_budget_usd: 10, pilot_limit_usd: .25, phase: 'automatic', estimated_month_spend: 0, reserved_usd: 0, actual_month_spend: null, unreconciled_jobs: 0, jobs: [], preferences_editable: true, processing_ready: true };
const reel = demo.reels[0];
const detail: ReelDetail = { reel, media: { urls: [], observed_at: null }, transcript: { reel_id: reel.id, status: 'not_requested', text: null, language: null, segments: [], model: null, completed_at: null, error_message: null }, processing: { request_allowed: true, reason: null, estimate: null } };
const sourcePath = `/api/workspaces/${workspace.id}/creators/creator/source-refresh`;
const detailPath = `/api/workspaces/${workspace.id}/reels/${reel.id}`;
const unrelatedPath = '/api/carousel-filters';
const reads = new Map<string, number>();
const data = new Map<string, unknown>();
const pendingReads: (() => void)[] = [];
let holdReads = false;
let rejectWrite = false;
let rejectBootstrap = false;
const notify = vi.fn();
const fetchMock = vi.fn(async (path: string, options: RequestInit = {}) => {
  if ((options.method ?? 'GET') !== 'GET') {
    if (rejectWrite) return { ok: false, status: 400, json: async () => ({ error: { message: 'Write rejected' } }) };
    const input = JSON.parse(options.body as string || '{}');
    if (path === '/api/settings') {
      bootstrap.settings = { ...bootstrap.settings, ...input }; data.set('/api/bootstrap', { ...bootstrap });
      return { ok: true, status: 200, json: async () => bootstrap.settings };
    }
    if (path === '/api/transcription') {
      const value = { ...(data.get(path) as TranscriptOverview), ...input }; data.set(path, value);
      return { ok: true, status: 200, json: async () => value };
    }
    if (path === sourcePath) {
      data.set(path, { job_id: 'source-job', status: 'pending', source_refresh: true, results_limit: 100, coverage_recorded: false, expected_reels: null, returned_reels: 0, missing_reels: 0, missing_captions: 0, missing_media: 0, completed_at: null, missing: [] } satisfies SourceReport);
      return { ok: true, status: 200, json: async () => ({ job_id: 'source-job', message: 'Source refresh queued.', processing: 'configuration_required' }) };
    }
    if (path === `${detailPath}/transcript`) {
      const value = { ...detail, transcript: { ...detail.transcript, status: 'queued' as const }, processing: { ...detail.processing, priority: 'high' as const } }; data.set(detailPath, value);
      return { ok: true, status: 200, json: async () => value };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }
  reads.set(path, (reads.get(path) ?? 0) + 1);
  if (holdReads) await new Promise<void>(resolve => pendingReads.push(resolve));
  if (path === '/api/bootstrap' && rejectBootstrap) return { ok: false, status: 503, json: async () => ({ error: { message: 'Bootstrap unavailable' } }) };
  return { ok: true, status: 200, json: async () => data.get(path) ?? [] };
});
function expectReads(path: string, count: number) { expect(reads.get(path) ?? 0, path).toBe(count); }
async function releaseReads() { holdReads = false; pendingReads.splice(0).forEach(resolve => resolve()); await flush(); }
async function prepare() {
  observe('/api/bootstrap'); observe(unrelatedPath); await flush(); reads.clear(); fetchMock.mockClear(); holdReads = true;
}

beforeEach(() => {
  clearResourceCache(); vi.useFakeTimers(); vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(), sessionStorage: { getItem: () => null, setItem: vi.fn() } });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  reads.clear(); data.clear(); pendingReads.length = 0; holdReads = false; rejectWrite = false; rejectBootstrap = false;
  bootstrap.settings = { ...demo.settings }; data.set('/api/bootstrap', { ...bootstrap }); data.set('/api/transcription', { ...overview }); data.set(sourcePath, null); data.set(detailPath, detail);
  notify.mockClear(); fetchMock.mockClear(); hooks.router.push.mockClear(); hooks.router.replace.mockClear();
  hooks.params = new URLSearchParams(); hooks.pathname = '/settings';
});
afterEach(async () => {
  hooks.active = null; cleanups.splice(0).forEach(cleanup => cleanup()); clearResourceCache(); await releaseReads(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('component request owners after successful mutations', () => {
  it('saves collection preferences with one bootstrap refresh and preserves saved draft feedback', async () => {
    const app = harness(() => App({ section: 'settings' })); app.render(); await flush();
    const settingsElement = nested(app.render(), 'Settings');
    expect(settingsElement.props).not.toHaveProperty('updated');
    const settings = harness(() => Settings({ bootstrap: settingsElement.props.bootstrap as Bootstrap, notify }));
    change(find(settings.render(), element => element.type === 'input' && element.props['aria-describedby'] === 'collection-budget-hint'), '42');
    await prepare(); await submit(byLabel(settings.render(), 'Collection preferences')); settings.render(); app.render(); await flush();
    expectReads('/api/bootstrap', 1); expectReads(unrelatedPath, 0);
    const savedForm = byLabel(settings.render(), 'Collection preferences');
    expect(find(savedForm, element => element.props['aria-describedby'] === 'collection-budget-hint').props.value).toBe('42');
    expect(byLabel(savedForm, 'Save changes to collection preferences').props.disabled).toBe(true);
    expect(notify).toHaveBeenCalledWith('Collection preferences saved.');
    await releaseReads(); expectReads('/api/bootstrap', 1);
  });

  it.each(['spending', 'pause'] as const)('updates transcription %s with one refresh per subscribed resource', async action => {
    const settings = harness(() => Settings({ bootstrap, notify }));
    const transcription = childHarness(nested(settings.render(), 'TranscriptionSection')); transcription.render(); await flush();
    let tree = transcription.render();
    if (action === 'spending') { change(find(tree, element => element.props['aria-describedby'] === 'transcription-budget-hint'), '25'); tree = transcription.render(); }
    await prepare();
    if (action === 'spending') await submit(byLabel(tree, 'Transcription spending preferences'));
    else await byText(tree, 'Pause requests').props.onClick!();
    tree = transcription.render(); await flush();
    expectReads('/api/transcription', 1); expectReads('/api/bootstrap', 1); expectReads(unrelatedPath, 0);
    if (action === 'spending') {
      expect(find(tree, element => element.props['aria-describedby'] === 'transcription-budget-hint').props.value).toBe('25');
      expect(byLabel(tree, 'Save changes to transcription preferences').props.disabled).toBe(true);
    } else expect(byText(tree, 'Resume requests')).toBeDefined();
    await releaseReads(); expectReads('/api/transcription', 1); expectReads('/api/bootstrap', 1);
  });

  it.each(['create', 'rename', 'archive', 'restore'] as const)('keeps the %s workspace mutation centrally owned and closes successful dialogs', async action => {
    const app = harness(() => App({ section: 'workspaces' })); app.render(); await flush();
    expect(nested(app.render(), 'Workspaces').props).not.toHaveProperty('updated');
    const archived: Workspace = { ...workspace, archived_at: '2026-11-15T00:00:00Z' };
    const workspaces = harness(() => Workspaces({ bootstrap: { ...bootstrap, workspaces: [action === 'restore' ? archived : workspace] }, notify }));
    let tree = workspaces.render();
    if (action === 'create') byText(tree, 'New workspace').props.onClick!();
    else if (action === 'rename') byLabel(tree, `Rename ${workspace.name}`).props.onClick!();
    else if (action === 'archive') byLabel(tree, `Archive ${workspace.name}`).props.onClick!();
    else find(tree, element => element.type === 'input' && element.props.type === 'checkbox').props.onChange!({ target: { checked: true } });
    tree = workspaces.render();
    if (action === 'create' || action === 'rename') { change(find(tree, element => element.type === 'input' && element.props.placeholder === 'Workspace name'), 'New name'); tree = workspaces.render(); }
    await prepare();
    if (action === 'create' || action === 'rename') await submit(find(tree, element => element.type === 'form'));
    else await byText(tree, action === 'archive' ? 'Archive workspace' : 'Restore workspace').props.onClick!();
    tree = workspaces.render(); app.render(); await flush();
    expectReads('/api/bootstrap', 1); expectReads(unrelatedPath, 0);
    expect(() => nested(tree, 'Dialog')).toThrow('Expected control not found');
    expect(notify).toHaveBeenCalled();
    await releaseReads(); expectReads('/api/bootstrap', 1);
  });

  it('queues source recovery once, then keeps the explicit five-second status polling', async () => {
    const source = harness(() => CreatorSourceRefresh({ workspaceId: workspace.id, creatorId: 'creator', notify })); source.render(); await flush();
    await prepare(); await find(source.render(), element => element.type === 'button').props.onClick!(); await flush(); source.render(); await flush();
    expectReads(sourcePath, 1); expectReads('/api/bootstrap', 1); expectReads(unrelatedPath, 0);
    expect(notify).toHaveBeenCalledWith('Refresh queued. Background processing configuration is required.');
    await releaseReads(); expectReads(sourcePath, 1);
    const processing = source.render(); expect(find(processing, element => element.type === 'button').props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(4999); source.render(); await flush(); expectReads(sourcePath, 1);
    await vi.advanceTimersByTimeAsync(1); source.render(); await flush(); expectReads(sourcePath, 2);
  });

  it.each([false, true])('requests a transcript once without a trailing detail read (fenced retry: %s)', async retry => {
    if (retry) data.set(detailPath, { ...detail, transcript: { ...detail.transcript, status: 'uncertain' }, processing: { ...detail.processing, retry_attempt_id: 'attempt-id' } });
    const view = childHarness(ReelDetailDialog({ reel, workspaceId: workspace.id, onSave: () => {}, onClose: () => {} }) as ReactElement<Props>);
    view.render(); await flush(); await prepare();
    await (nested(view.render(), 'ReelResearchPanels').props.request as () => Promise<void>)(); view.render(); await flush();
    expectReads(detailPath, 1); expectReads('/api/bootstrap', 1); expectReads(unrelatedPath, 0);
    const write = fetchMock.mock.calls.find(([path]) => path === `${detailPath}/transcript`)!;
    expect(JSON.parse(write[1]!.body as string)).toEqual(retry ? { retry_attempt_id: 'attempt-id', accept_duplicate_charge: true } : {});
    await releaseReads(); expectReads(detailPath, 1);
    view.render(); await vi.advanceTimersByTimeAsync(5000); view.render(); await flush(); expectReads(detailPath, 2);
  });

  it('preserves workspace drafts and dialogs after rejected writes without refreshing reads', async () => {
    const workspaces = harness(() => Workspaces({ bootstrap, notify })); byText(workspaces.render(), 'New workspace').props.onClick!();
    change(find(workspaces.render(), element => element.type === 'input' && element.props.placeholder === 'Workspace name'), 'Keep this draft');
    await prepare(); rejectWrite = true; await submit(find(workspaces.render(), element => element.type === 'form')); const tree = workspaces.render(); await flush();
    expect(find(tree, element => element.type === 'input' && element.props.placeholder === 'Workspace name').props.value).toBe('Keep this draft');
    expect(byText(tree, 'Write rejected')).toBeDefined(); expect(nested(tree, 'Dialog')).toBeDefined();
    expectReads('/api/bootstrap', 0); expectReads(unrelatedPath, 0); expect(notify).not.toHaveBeenCalled();
  });
});

describe('explicit retry and manual refresh owners', () => {
  it.each([
    { saved: false, mode: 'supabase' }, { saved: true, mode: 'supabase' },
    { saved: false, mode: 'demo' }, { saved: true, mode: 'demo' },
  ] as const)('reloads stored carousel resources only from the topbar ($saved, $mode)', async ({ saved, mode }) => {
    hooks.pathname = saved ? '/saved/carousels' : '/carousels';
    hooks.params = new URLSearchParams({ creator: reel.creator_id });
    data.set('/api/bootstrap', { ...bootstrap, mode });
    const app = harness(() => App({ section: saved ? 'saved' : 'carousels', savedCarousels: saved }));
    app.render(); await flush();
    const selectedPath = `/api/workspaces/${workspace.id}/carousel-summaries?creator=${reel.creator_id}&page=1&limit=30`;
    const savedPath = `/api/workspaces/${workspace.id}/carousel-summaries?saved=true&page=1&limit=30`;
    const statusPath = `/api/workspaces/${workspace.id}/carousels/collection-status`;
    const unrelatedWorkspacePath = '/api/workspaces/other/carousel-summaries?page=1&limit=30';
    const reelPath = `/api/workspaces/${workspace.id}/reels?page=1`;
    for (const path of [selectedPath, savedPath, statusPath, unrelatedWorkspacePath, reelPath, unrelatedPath]) observe(path);
    await flush(); reads.clear(); fetchMock.mockClear();
    const topbar = find(app.render(), element => element.type === 'header' && element.props.className === 'topbar');
    const reload = byText(topbar, 'Reload library');
    expect(reload.props.disabled).toBe(false);
    expect(reload.props.title).toContain('without requesting paid collection');
    await reload.props.onClick!(); await flush();
    for (const path of [selectedPath, savedPath, statusPath]) expectReads(path, 1);
    for (const path of [unrelatedWorkspacePath, reelPath, unrelatedPath, '/api/bootstrap']) expectReads(path, 0);
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    expect(nested(app.render(), 'Toasts').props.messages).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'Reloading stored carousel data. No collection was requested.' })]));
  });

  it.each(['jobs', 'settings'] as const)('keeps owner-wide %s usable and read-only without an active workspace', async section => {
    hooks.pathname = '/' + section;
    data.set('/api/bootstrap', { ...bootstrap, workspaces: [] });
    const app = harness(() => App({ section }));
    app.render(); await flush();
    const child = nested(app.render(), section === 'jobs' ? 'Jobs' : 'Settings');
    expect(child.props.bootstrap).toMatchObject({ workspaces: [] });
    expect(child.props.refresh).toBeUndefined();
    const page = childHarness(child); page.render();
    observe(unrelatedPath); await flush();
    const refresh = byText(find(app.render(), element => element.type === 'header'), section === 'jobs' ? 'Refresh activity' : 'Refresh settings');
    expect(refresh.props.disabled).toBe(false);
    reads.clear(); fetchMock.mockClear(); await refresh.props.onClick!(); await flush();
    expectReads('/api/bootstrap', 1); expectReads(unrelatedPath, 0);
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    if (section === 'jobs') {
      reads.clear(); fetchMock.mockClear();
      await byText(page.render(), 'Refresh activity').props.onClick!(); page.render(); await flush();
      expectReads('/api/bootstrap', 1);
      expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    }
  });

  it.each([true, false])('retries only bootstrap after a load failure (last-good data: %s)', async lastGood => {
    const app = harness(() => App({ section: 'settings' }));
    if (!lastGood) rejectBootstrap = true;
    app.render(); observe(unrelatedPath); await flush();
    if (lastGood) { rejectBootstrap = true; invalidateResources('/api/bootstrap'); await flush(); }
    expect(getResourceSnapshot('/api/bootstrap').error).toBe('Bootstrap unavailable');
    const tree = app.render(); reads.clear(); rejectBootstrap = false;
    if (lastGood) byText(tree, 'Retry').props.onClick!();
    else (nested(tree, 'ErrorState').props.retry as () => void)();
    await flush(); expectReads('/api/bootstrap', 1); expectReads(unrelatedPath, 0);
  });

  it('keeps manual transcription status refresh read-only and resource-specific', async () => {
    const jobs = harness(() => Jobs({ bootstrap, notify, refresh: async () => {}, revision: 0 }));
    find(jobs.render(), element => element.type === 'details' && element.props.className === 'jobs-transcription-toggle').props.onToggle!({ currentTarget: { open: true } });
    const transcription = childHarness(nested(jobs.render(), 'TranscriptionSection')); transcription.render(); observe(unrelatedPath); await flush();
    reads.clear(); fetchMock.mockClear(); byLabel(transcription.render(), 'Refresh transcription status').props.onClick!(); transcription.render(); await flush();
    expectReads('/api/transcription', 1); expectReads('/api/bootstrap', 0); expectReads(unrelatedPath, 0);
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('keeps the transcript viewer manual refresh read-only', async () => {
    const viewer = harness(() => TranscriptViewer({ workspaceId: workspace.id, reelId: reel.id, username: reel.username, onClose: () => {} }));
    viewer.render(); observe(unrelatedPath); await flush(); reads.clear(); fetchMock.mockClear();
    find(viewer.render(), element => element.type === 'button' && element.props.disabled !== undefined).props.onClick!(); viewer.render(); await flush();
    expectReads(`${detailPath}/transcript`, 1); expectReads(unrelatedPath, 0);
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
});
