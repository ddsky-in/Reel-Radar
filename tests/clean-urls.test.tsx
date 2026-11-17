import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bootstrap, Workspace } from '../src/lib/types';
import { appPath, reelDetailPath, reelReturnPath, selectedWorkspace } from '../src/lib/app-navigation';
import { rememberWorkspace, workspaceSelectionKey } from '../src/lib/workspace-selection';
import { App } from '../src/components/app';

const fixture = vi.hoisted(() => ({ bootstrap: null as Bootstrap | null, effects: [] as (() => void)[], replace: vi.fn(), params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fixture.replace, push: vi.fn() }), useSearchParams: () => fixture.params, usePathname: () => '/reels' }));
vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return { ...react, useEffect: (effect: () => void) => { fixture.effects.push(effect); }, useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() };
});
vi.mock('../src/components/ui', async () => {
  const ui = await vi.importActual<typeof import('../src/components/ui')>('../src/components/ui');
  return { ...ui, useResource: () => ({ data: fixture.bootstrap, loading: false, error: null }) };
});
vi.mock('../src/components/dashboard', () => ({ Dashboard: ({ workspaceId }: { workspaceId: string }) => createElement('div', { 'data-workspace': workspaceId }) }));
vi.mock('../src/components/explorer', () => ({ Explorer: ({ workspaceId }: { workspaceId: string }) => createElement('div', { 'data-workspace': workspaceId }) }));
vi.mock('../src/components/competitors', () => ({ Competitors: () => null }));
vi.mock('../src/components/workspaces', () => ({ Workspaces: () => null }));
vi.mock('../src/components/operations', () => ({ Jobs: () => null, Settings: () => null }));
vi.mock('../src/components/reel-detail', () => ({ ReelDetailPage: ({ workspaceId, reelId }: { workspaceId: string; reelId: string }) => createElement('div', { 'data-detail-workspace': workspaceId, 'data-reel': reelId }) }));
vi.mock('../src/lib/supabase/realtime', () => ({ startAppSync: () => () => {} }));

const first: Workspace = { id: '00000000-0000-4000-8000-000000000001', name: 'First', slug: 'first', created_at: '2026-11-01T00:00:00Z', archived_at: null };
const second: Workspace = { ...first, id: '00000000-0000-4000-8000-000000000002', name: 'Second', slug: 'second' };
const archived: Workspace = { ...first, id: '00000000-0000-4000-8000-000000000003', archived_at: '2026-11-02T00:00:00Z' };
const workspaces = [first, second, archived];
function setup(email: string) {
  fixture.effects = []; fixture.replace.mockClear(); fixture.params = new URLSearchParams();
  fixture.bootstrap = { mode: 'demo', email, workspaces, settings: {}, usage: {}, jobs: [] } as unknown as Bootstrap;
  const storage = new Map<string, string>();
  vi.stubGlobal('window', { sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  return storage;
}
afterEach(() => { vi.unstubAllGlobals(); fixture.effects = []; });

describe('clean application URLs and workspace context', () => {
  it('keeps the workspace and previous filters in a detail link without allowing external return URLs', () => {
    const link = new URL(reelDetailPath(first.id, second.id, '/reels?keywords=AI+tools&view=table'), 'http://localhost');
    expect(link.pathname).toBe(`/reels/${first.id}`);
    expect(link.searchParams.get('workspace')).toBe(second.id);
    expect(link.searchParams.get('returnTo')).toBe('/reels?keywords=AI+tools&view=table');
    for (const unsafe of ['https://outside.test', '//outside.test', '/\\outside.test', '/reels/../login', '/reels%2f..%2flogin', '/unknown', '/outliers', '/outliers?min_outlier=10']) expect(reelReturnPath(unsafe)).toBe('/reels');
  });

  it('opens a deep-linked Reel only in an authorized active workspace', () => {
    const storage = setup('detail@example.test');
    fixture.params = new URLSearchParams({ workspace: second.id });
    const html = renderToStaticMarkup(createElement(App, { section: 'reels', reelId: first.id }));
    expect(html).toContain(`data-detail-workspace="${second.id}"`);
    fixture.effects.forEach(effect => effect());
    expect(storage.get(workspaceSelectionKey('demo', 'detail@example.test'))).toBe(second.id);
    for (const denied of ['missing', archived.id]) {
      setup(`${denied}@example.test`);
      fixture.params = new URLSearchParams({ workspace: denied });
      expect(renderToStaticMarkup(createElement(App, { section: 'reels', reelId: first.id }))).not.toContain('data-detail-workspace');
    }
  });

  it('uses readable top-level navigation and never bounces a clean page into an ID route', () => {
    setup('navigation@example.test');
    const html = renderToStaticMarkup(createElement(App, { section: 'reels' }));
    for (const path of ['/dashboard', '/reels', '/creators', '/saved', '/jobs', '/settings', '/workspaces']) expect(html).toContain(`href="${path}"`);
    expect(html).not.toContain('href="/outliers"');
    expect(html).not.toContain('>Outliers</span>');
    expect(html).not.toContain('href="/w/');
    fixture.effects.forEach(effect => effect());
    expect(fixture.replace).not.toHaveBeenCalled();
  });

  it('restores a selected authorized workspace when navigating clean pages', () => {
    const storage = setup('selection@example.test');
    const key = workspaceSelectionKey('demo', 'selection@example.test');
    rememberWorkspace(key, second.id);
    expect(storage.get(key)).toBe(second.id);
    expect(renderToStaticMarkup(createElement(App, { section: 'reels' }))).toContain(`data-workspace="${second.id}"`);
    expect(renderToStaticMarkup(createElement(App, { section: 'overview' }))).toContain(`data-workspace="${second.id}"`);
  });

  it('redirects a valid legacy link while preserving its workspace and filter parameters', () => {
    const storage = setup('legacy@example.test');
    fixture.params = new URLSearchParams('keywords=AI+tools&min_views=100&view=table');
    renderToStaticMarkup(createElement(App, { section: 'reels', workspaceId: second.id }));
    fixture.effects.forEach(effect => effect());
    expect(storage.get(workspaceSelectionKey('demo', 'legacy@example.test'))).toBe(second.id);
    expect(fixture.replace).toHaveBeenCalledWith('/reels?keywords=AI+tools&min_views=100&view=table');
  });

  it('does not turn inaccessible, archived or unknown legacy pages into another workspace', () => {
    for (const [workspaceId, section] of [['missing', 'reels'], [archived.id, 'reels'], [second.id, 'unknown'], [second.id, 'outliers']]) {
      setup(`${workspaceId}-${section}@example.test`);
      renderToStaticMarkup(createElement(App, { workspaceId, section }));
      fixture.effects.forEach(effect => effect());
      expect(fixture.replace).not.toHaveBeenCalled();
    }
    expect(selectedWorkspace(workspaces, first.id, 'missing')).toBeUndefined();
  });

  it('treats storage as a preference, scoped by account and validated against active workspaces', () => {
    expect(selectedWorkspace(workspaces, second.id)).toBe(second);
    expect(selectedWorkspace(workspaces, 'someone-elses-workspace')).toBe(first);
    expect(selectedWorkspace(workspaces, archived.id)).toBe(first);
    expect(selectedWorkspace([archived], null)).toBeUndefined();
    expect(workspaceSelectionKey('demo', 'OWNER@EXAMPLE.TEST ')).toBe(workspaceSelectionKey('demo', 'owner@example.test'));
    expect(workspaceSelectionKey('demo', 'owner@example.test')).not.toBe(workspaceSelectionKey('supabase', 'owner@example.test'));
    expect(workspaceSelectionKey('supabase', 'owner@example.test')).not.toBe(workspaceSelectionKey('supabase', 'other@example.test'));
    for (const section of ['unknown', '__proto__', 'constructor', '//outside.test']) expect(appPath(section)).toBe('/dashboard');
  });
});
