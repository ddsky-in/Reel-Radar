'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Download, Grid2X2, List } from 'lucide-react';
import { errorMessage } from '@/lib/client';
import { saveReel } from '@/lib/reel-save';
import { defaultReelFilters, readReelFilters, reelQueryString } from '@/lib/reel-filters';
import { useNavigationQueryGuard } from '@/lib/navigation-intent';
import type { PageResult, Reel, ReelQuery } from '@/lib/types';
import { formatNumber } from '@/lib/format';
import { Empty, ErrorState, Skeleton, useResource, type Notify } from './ui';
import { ReelCard, ReelTable } from './reels';
import { ReelFilters, ReelPagination, activeFilterItems, filterScope } from './reel-filters';
import { ReelListContext } from './reel-navigation';
import { ResearchTabs } from './carousels';

export function Explorer({ section, workspaceId, notify }: { section: 'reels' | 'saved'; workspaceId: string; notify: Notify }) {
  const router = useRouter(), pathname = usePathname(), searchParams = useSearchParams();
  const navigationGuard = useNavigationQueryGuard(pathname);
  const [revision, setRevision] = useState(0), [exporting, setExporting] = useState(false);
  const isSaved = section === 'saved';
  const params = searchParams.toString();
  const [draft, setDraft] = useState<{ source: string; target: string; query: ReelQuery; epoch: number } | null>(null);
  let queryError = '';
  let filters: ReelQuery;
  try { filters = draft && draft.epoch === navigationGuard.epoch && (draft.source === params || draft.target === params) ? draft.query : readReelFilters(new URLSearchParams(params)); }
  catch (failure) { filters = defaultReelFilters(); queryError = errorMessage(failure); }
  const page = filters.page ?? 1;
  const grid = searchParams.get('view') !== 'table';
  const query = filterScope({ ...filters, page, limit: 30 }, { savedOnly: isSaved });
  const hasActiveFilters = activeFilterItems(query, { savedOnly: isSaved }).length > 0;
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const resource = useResource<PageResult<Reel>>(queryError ? null : `${base}/reels?${reelQueryString(query)}`, revision);
  function apply(next: ReelQuery) {
    if (!navigationGuard.canCommit()) return;
    const scoped = filterScope({ ...next, limit: undefined }, { savedOnly: isSaved });
    const updated = new URLSearchParams(reelQueryString(scoped));
    if (!grid) updated.set('view', 'table');
    setDraft({ source: params, target: updated.toString(), query: scoped, epoch: navigationGuard.epoch });
    router.replace(`${pathname}?${updated.toString()}`, { scroll: false });
  }
  function clear() { apply({ ...defaultReelFilters(), sort: query.sort }); }
  function view(next: 'grid' | 'table') {
    if (!navigationGuard.canCommit()) return;
    const updated = new URLSearchParams(params);
    if (next === 'table') updated.set('view', next); else updated.delete('view');
    router.replace(`${pathname}${updated.size ? '?' + updated : ''}`, { scroll: false });
  }
  async function toggleSave(reel: Reel) {
    try {
      if (!await saveReel(workspaceId, reel)) return;
      notify(reel.saved ? 'Removed from saved research.' : 'Saved to this workspace.');
    } catch (failure) { notify(errorMessage(failure), 'error'); }
  }
  async function exportCsv() {
    setExporting(true);
    try {
      const response = await fetch(`${base}/export?${reelQueryString({ ...query, page: undefined, limit: undefined })}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) { const failure = await response.json().catch(() => null); throw new Error(failure?.error?.message ?? 'Could not export CSV.'); }
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `reelradar-${section}-${new Date().toISOString().slice(0, 10)}.csv`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); notify('Filtered research exported.');
    } catch (failure) { notify(errorMessage(failure), 'error'); } finally { setExporting(false); }
  }
  return <ReelListContext.Provider value={query}>
    <div className="page-heading"><div><h1>{isSaved ? 'Saved research' : 'Reels explorer'}</h1></div></div>
    {isSaved && <ResearchTabs/>}
    <div className="reel-explorer-layout">
      <aside className="reel-filter-sidebar" aria-label="Reel filters"><ReelFilters key={navigationGuard.epoch} workspaceId={workspaceId} value={query} onChange={apply} notify={notify} savedOnly={isSaved} layout="sidebar"/></aside>
      <section className="reel-explorer-results" aria-label={isSaved ? 'Saved Reel results' : 'Reel results'}>
        <div className="results-toolbar"><span>{resource.loading ? 'Finding Reels…' : <><strong>{formatNumber(resource.data?.total ?? 0)}</strong> {isSaved ? 'saved Reels' : 'Reels found'}{hasActiveFilters && ' · filtered'}</>}</span><div><label className="sort-field">Sort by<select aria-label="Sort Reels" value={query.sort ?? 'published_at'} onChange={event => apply({ ...query, sort: event.target.value as ReelQuery['sort'], page: 1 })}><option value="published_at">Newest first</option><option value="views">Most views</option><option value="likes">Most likes</option><option value="comments">Most comments</option><option value="engagement">Engagement rate</option><option value="outlier">Follower outlier</option><option value="profile_outlier">Profile outlier</option></select></label><div className="view-toggle" role="group" aria-label="Display view"><button aria-label="Grid view" aria-pressed={grid} className={grid ? 'selected' : ''} onClick={() => view('grid')}><Grid2X2 size={16}/></button><button aria-label="Table view" aria-pressed={!grid} className={!grid ? 'selected' : ''} onClick={() => view('table')}><List size={17}/></button></div><button className="button button-secondary explorer-export" onClick={exportCsv} disabled={exporting || Boolean(queryError)}><Download size={16}/>{exporting ? 'Exporting…' : 'Export CSV'}</button></div></div>
        {queryError ? <ErrorState message={queryError} retry={clear}/> : <>
          {resource.error && resource.data && <p className="inline-error" role="status">Background update failed: {resource.error} <button className="text-link" onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
          {resource.loading ? <Skeleton cards={grid}/> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={() => setRevision(value => value + 1)}/> : !resource.data?.items.length ? <Empty title={isSaved ? 'No saved Reels match these filters' : 'No Reels match these filters'} description="Change your ranges, channels or keywords. Clear removes all optional filter conditions." action={<button className="button button-secondary" onClick={clear}>Clear filters</button>}/> : grid ? <div className="reel-grid">{resource.data.items.map(reel => <ReelCard key={reel.id} workspaceId={workspaceId} reel={reel} onSave={toggleSave}/>)}</div> : <ReelTable workspaceId={workspaceId} reels={resource.data.items} onSave={toggleSave}/>} 
          {resource.data && <ReelPagination page={page} limit={30} total={resource.data.total} count={resource.data.items.length} loading={resource.loading} onPage={next => apply({ ...query, page: next })}/>} 
        </>}
      </section>
    </div>
  </ReelListContext.Provider>;
}
