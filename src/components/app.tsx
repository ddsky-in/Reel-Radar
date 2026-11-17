'use client';

import { useEffect, useRef, useState } from 'react';
import Link, { useLinkStatus } from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Activity, Bookmark, ChevronDown, Film, FolderOpen, LayoutDashboard, LogOut, Menu, Plus, RefreshCw, Settings2, Users, X } from 'lucide-react';
import type { Bootstrap } from '@/lib/types';
import { api, errorMessage } from '@/lib/client';
import { invalidateResourceFamilies, invalidateResources } from '@/lib/resource-cache';
import { startAppSync } from '@/lib/supabase/realtime';
import { appPath, reelDetailPath, reelReturnPath, reelListQuery, selectedWorkspace } from '@/lib/app-navigation';
import { rememberWorkspace, useWorkspaceSelection, workspaceSelectionKey } from '@/lib/workspace-selection';
import { createNavigationIntent, NavigationIntentContext, useNavigationIntentEpoch, type NavigationIntentController } from '@/lib/navigation-intent';
import { Dashboard } from './dashboard';
import { Explorer } from './explorer';
import { Competitors } from './competitors';
import { Workspaces } from './workspaces';
import { Jobs, Settings } from './operations';
import { Empty, ErrorState, Logo, Skeleton, Toasts, useResource, type Notify } from './ui';
import { ReelHrefContext, ReelNavigationContext } from './reel-navigation';
import { ReelDetailPage } from './reel-detail';
import { Layers } from 'lucide-react';
import { Carousels } from './carousels';

const navigation = [
  { id: 'overview', label: 'Dashboard', icon: LayoutDashboard }, { id: 'reels', label: 'Reels explorer', icon: Film },
  { id: 'carousels', label: 'Carousels', icon: Layers },
  { id: 'competitors', label: 'Competitors', icon: Users },
  { id: 'saved', label: 'Saved research', icon: Bookmark }, { id: 'workspaces', label: 'Workspaces', icon: FolderOpen },
  { id: 'jobs', label: 'Job activity', icon: Activity }, { id: 'settings', label: 'Settings', icon: Settings2 },
];

function NavigationFeedback({ controller, href }: { controller: NavigationIntentController; href: string }) {
  const { pending } = useLinkStatus();
  const epoch = useNavigationIntentEpoch(controller);
  const pendingEpoch = useRef<number | null>(null);
  useEffect(() => {
    if (pending) {
      const intent = controller.getPending();
      if (intent?.href === href) pendingEpoch.current = intent.epoch;
    } else if (pendingEpoch.current !== null) {
      controller.cancelLink(pendingEpoch.current, window.location.pathname + window.location.search);
      pendingEpoch.current = null;
    }
  }, [controller, href, pending, epoch]);
  const intent = controller.getPending();
  return intent?.href === href ? <RefreshCw size={13} className="spin" aria-label="Opening page"/> : null;
}

export function App({ section = 'overview', workspaceId, reelId, savedCarousels=false }: { section?: string; workspaceId?: string; reelId?: string; savedCarousels?:boolean }) {
  const router = useRouter(), searchParams = useSearchParams(), pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false), [refreshing, setRefreshing] = useState(false);
  const mobileMenu = useRef<HTMLButtonElement>(null);
  function closeNavigation() { setMobileOpen(false); mobileMenu.current?.focus(); }
  const queryString = searchParams.toString();
  const currentUrl = `${pathname}${queryString ? '?' + queryString : ''}`;
  const [navigationIntent] = useState(() => createNavigationIntent(pathname, currentUrl));
  const navigationEpoch = useNavigationIntentEpoch(navigationIntent);
  useEffect(() => navigationIntent.observe(pathname, currentUrl), [navigationIntent, pathname, currentUrl]);
  useEffect(() => {
    const onPopState = () => { navigationIntent.begin(window.location.pathname + window.location.search); setMobileOpen(false); };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [navigationIntent]);
  const resource = useResource<Bootstrap>('/api/bootstrap');
  const { data: bootstrap, loading, error } = resource;
  const selectionKey = bootstrap ? workspaceSelectionKey(bootstrap.mode, bootstrap.email) : null;
  const rememberedId = useWorkspaceSelection(selectionKey);
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: 'success' | 'error' }[]>([]);
  const notify: Notify = (message, kind = 'success') => {
    const id = Date.now() + Math.random(); setToasts(items => [...items.slice(-3), { id, message, kind }]);
    setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), kind === 'error' ? 9000 : 4500);
  };
  useEffect(() => {
    if (!bootstrap || !selectionKey || !workspaceId || !navigation.some(item => item.id === section) || !navigationIntent.canCommit(pathname, navigationEpoch)) return;
    const legacyWorkspace = bootstrap.workspaces.find(workspace => workspace.id === workspaceId);
    if (!legacyWorkspace || legacyWorkspace.archived_at) return;
    rememberWorkspace(selectionKey, legacyWorkspace.id);
    const query = searchParams.toString();
    router.replace(`${appPath(section)}${query ? '?' + query : ''}`);
  }, [bootstrap, router, section, workspaceId, selectionKey, searchParams, navigationIntent, pathname, navigationEpoch]);
  const realtimeEnabled = bootstrap?.mode === 'supabase';
  useEffect(() => realtimeEnabled ? startAppSync(() => router.replace('/login')) : undefined, [realtimeEnabled, router]);
  const explicitWorkspace = workspaceId ?? (reelId ? searchParams.get('workspace') ?? undefined : undefined);
  const workspace = bootstrap ? selectedWorkspace(bootstrap.workspaces, rememberedId, explicitWorkspace) : undefined;
  useEffect(() => {
    if (reelId && explicitWorkspace && workspace && !workspace.archived_at && selectionKey) rememberWorkspace(selectionKey, workspace.id);
  }, [reelId, explicitWorkspace, workspace, selectionKey]);
  const activeWorkspaces = bootstrap?.workspaces.filter(workspace => !workspace.archived_at) ?? [];
  const currentSection = navigation.some(item => item.id === section) ? section : 'unknown';
  const carouselPage = currentSection === 'carousels' || savedCarousels;
  const ownerPage = currentSection === 'jobs' || currentSection === 'settings';
  const refreshLabel = carouselPage ? 'Reload library' : currentSection === 'jobs' ? 'Refresh activity' : currentSection === 'settings' ? 'Refresh settings' : 'Refresh data';
  const listQuery = reelId ? reelListQuery(searchParams.get('list'), searchParams.get('returnTo')) : null;
  const link = appPath;
  function beginNavigation(href: string) {
    navigationIntent.begin(href);
    setMobileOpen(false);
  }
  function navigate(href: string, replace = false, scroll = true) {
    const epoch = navigationIntent.begin(href);
    setMobileOpen(false);
    try { if (replace) router.replace(href, { scroll }); else router.push(href, { scroll }); }
    catch (failure) { navigationIntent.finish(epoch); throw failure; }
  }
  function switchWorkspace(id: string) {
    if (!selectionKey || !activeWorkspaces.some(workspace => workspace.id === id)) return;
    rememberWorkspace(selectionKey, id);
    navigate(savedCarousels ? '/saved/carousels' : appPath(currentSection), true);
  }
  function refreshResources() {
    if (carouselPage) {
      if (!workspace || workspace.archived_at) return;
      invalidateResourceFamilies(['carousels', 'saved_carousels'], workspace.id);
      notify('Reloading stored carousel data. No collection was requested.');
    } else {
      if (ownerPage) invalidateResourceFamilies(['jobs', 'settings', 'transcription', 'creators']);
      else invalidateResources('/api/bootstrap');
    }
  }
  async function refresh(creatorIds?: string[]) {
    if (!workspace || workspace.archived_at || refreshing) return; setRefreshing(true);
    try { const result = await api<{ job_id: string; message: string }>('/api/refresh', { method: 'POST', body: JSON.stringify({ workspace_id: workspace.id, ...(creatorIds?.length ? { creator_ids: creatorIds } : {}) }) }); notify(result.message); }
    catch (error) { notify(errorMessage(error), 'error'); } finally { setRefreshing(false); }
  }
  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); router.replace('/login'); } catch (error) { notify(errorMessage(error), 'error'); }
  }
  return <NavigationIntentContext.Provider value={navigationIntent}><ReelNavigationContext.Provider value={(reel, id, query) => navigate(reelDetailPath(reel.id, id, currentUrl, query))}><ReelHrefContext.Provider value={(reel, id, query) => reelDetailPath(reel.id, id, currentUrl, query)}><div className="app-shell">
    <a href="#main-content" className="skip-link">Skip to content</a>
    {mobileOpen && <div className="sidebar-backdrop" onClick={closeNavigation}/>}
    <aside id="app-navigation" className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`} onKeyDown={event => { if (event.key === 'Escape' && mobileOpen) { event.preventDefault(); closeNavigation(); } }}>
      <div className="sidebar-brand">
        <Link href={link('overview')} aria-label="ReelRadar dashboard" onNavigate={() => beginNavigation(link('overview'))}><Logo/><NavigationFeedback controller={navigationIntent} href={link('overview')}/></Link>
        <button className="icon-button mobile-close" aria-label="Close navigation" onClick={closeNavigation}><X size={20}/></button>
      </div>
      <div className="sidebar-workspace">
        <div className="sidebar-workspace-select">
          <FolderOpen size={16}/>
          <select aria-label="Sidebar workspace switcher" value={workspace?.id ?? ''} onChange={event => switchWorkspace(event.target.value)}>
            {!workspace && <option value="">Select workspace</option>}
            {activeWorkspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <ChevronDown size={13}/>
        </div>
      </div>
      <nav aria-label="Main navigation">
        {navigation.map(item => <Link href={link(item.id)} className={`nav-link ${currentSection === item.id ? 'nav-active' : ''} ${item.id === 'workspaces' ? 'nav-divider' : ''}`} key={item.id} aria-current={currentSection === item.id ? 'page' : undefined} aria-busy={navigationIntent.getPending()?.href === link(item.id) || undefined} onNavigate={() => beginNavigation(link(item.id))}>
          <item.icon size={18} strokeWidth={1.65}/><span>{item.label}</span><NavigationFeedback controller={navigationIntent} href={link(item.id)}/>
        </Link>)}
      </nav>
      <div className="sidebar-bottom">
        <button className="sidebar-account" onClick={logout} title="Sign out">
          <span className="account-avatar">{bootstrap?.email?.[0]?.toUpperCase() ?? 'R'}</span>
          <span><strong>Sign out</strong><small>{bootstrap?.email}</small></span><LogOut size={15}/>
        </button>
      </div>
    </aside>
    <div className="app-main">
      <header className="topbar">
        <div className="topbar-left">
          <button ref={mobileMenu} className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={mobileOpen} aria-controls="app-navigation" onClick={() => setMobileOpen(true)}><Menu size={21}/></button>
          <span className="breadcrumb">Workspace <span>/</span></span>
          <label className="top-workspace">
            <select aria-label="Workspace" value={workspace?.id ?? ''} onChange={event => switchWorkspace(event.target.value)}>
              {!workspace && <option value="">Choose workspace</option>}
              {activeWorkspaces.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select>
            <ChevronDown size={13}/>
          </label>
        </div>
        <div className="topbar-actions">
          <button className="button button-secondary refresh-button" onClick={() => carouselPage || ownerPage ? refreshResources() : refresh()} disabled={!bootstrap || !ownerPage && (!workspace || !!workspace.archived_at) || refreshing} title={carouselPage ? 'Read stored carousel data again without requesting paid collection' : ownerPage ? 'Reload owner-wide status without starting collection' : undefined}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''}/>{refreshing ? 'Refreshing…' : refreshLabel}
          </button>
          <Link href={link('settings')} className="top-avatar" aria-label="Open settings" onNavigate={() => beginNavigation(link('settings'))}>{bootstrap?.email?.[0]?.toUpperCase() ?? 'R'}<NavigationFeedback controller={navigationIntent} href={link('settings')}/></Link>
        </div>
      </header>
      {bootstrap?.mode === 'demo' && <div className="demo-banner"><span className="tiny-dot"/>Demo mode · synthetic data, not live Instagram data · no provider calls</div>}
      <main id="main-content" className="content" tabIndex={-1}>
        {error && bootstrap && <p className="inline-error" role="status">Background update failed: {error} <button className="text-link" onClick={() => invalidateResources('/api/bootstrap')}>Retry</button></p>}
        {loading ? <>
          <div className="page-heading"><div><h1>Loading workspace…</h1></div></div><Skeleton/>
        </> : error && !bootstrap ? <div className="setup-error">
          <h1>Unable to load workspace</h1>
          <ErrorState message={error} retry={() => invalidateResources('/api/bootstrap')}/>
          <Link className="button button-secondary" href="/login">Go to sign in</Link>
        </div> : bootstrap && <>
          {currentSection === 'unknown' ? <Empty title="Page not found" description="Choose a page from the navigation." action={<Link className="button button-accent" href={link('overview')}>Back to dashboard</Link>}/>
            : currentSection === 'workspaces' ? <Workspaces bootstrap={bootstrap} notify={notify}/>
            : currentSection === 'jobs' ? <Jobs bootstrap={bootstrap} notify={notify} revision={0}/>
            : currentSection === 'settings' ? <Settings bootstrap={bootstrap} notify={notify}/>
            : !workspace || workspace.archived_at ? <Empty title={workspace?.archived_at ? 'This workspace is archived' : 'No workspace selected'} description={workspace?.archived_at ? 'Restore it from the workspaces page, or switch to an active workspace.' : 'Create or open a workspace to continue.'} action={<Link className="button button-accent" href="/workspaces"><Plus size={16}/>Manage workspaces</Link>}/>
            : reelId ? <ReelDetailPage key={`${workspace.id}-${reelId}`} reelId={reelId} workspaceId={workspace.id} notify={notify} listQuery={listQuery} onNavigate={next => navigate(reelDetailPath(next, workspace.id, reelReturnPath(searchParams.get('returnTo')), listQuery ?? undefined), true, false)} onBack={() => navigate(reelReturnPath(searchParams.get('returnTo')))}/>
            : currentSection === 'overview' ? <Dashboard key={workspace.id} workspaceId={workspace.id} bootstrap={bootstrap} notify={notify} revision={0}/>
            : currentSection === 'carousels' || currentSection === 'saved' && savedCarousels ? <Carousels key={workspace.id+'-'+currentSection} workspaceId={workspace.id} notify={notify} savedOnly={savedCarousels} demo={bootstrap.mode==='demo'}/>
            : currentSection === 'reels' || currentSection === 'saved' ? <Explorer key={`${workspace.id}-${currentSection}`} section={currentSection} workspaceId={workspace.id} notify={notify}/>
            : currentSection === 'competitors' ? <Competitors key={`${workspace.id}-${selectionKey}`} workspaceId={workspace.id} workspaceName={workspace.name} mode={bootstrap.mode} notify={notify} refresh={refresh}/>
            : null}
        </>}
      </main>
    </div>
    <Toasts messages={toasts} dismiss={id => setToasts(items => items.filter(item => item.id !== id))}/>
  </div></ReelHrefContext.Provider></ReelNavigationContext.Provider></NavigationIntentContext.Provider>;
}
