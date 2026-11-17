'use client';

import { useContext, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bookmark, Heart, Layers, MessageCircle, RefreshCw } from 'lucide-react';
import type { Carousel, CarouselSummary, CarouselQuery, PageResult } from '@/lib/types';
import { api, errorMessage } from '@/lib/client';
import { invalidateResources } from '@/lib/resource-cache';
import { carouselActiveFilterCount, carouselQueryString, readCarouselQuery } from '@/lib/carousels';
import { NavigationIntentContext, useNavigationQueryGuard } from '@/lib/navigation-intent';
import { formatCompact, formatDate, formatNumber, formatPercent, formatScore } from '@/lib/format';
import { qualifiesOutlier } from '@/lib/metrics';
import { Avatar, Empty, ErrorState, Skeleton, SourceLink, useResource, type Notify } from './ui';
import { ReelPagination } from './reel-filters';
import { CarouselFilters } from './carousel-filters';
import { CarouselDialog, CarouselImage } from './carousel-detail';


export { CarouselGallery } from './carousel-detail';

export function ResearchTabs({ carousels = false }: { carousels?: boolean }) {
  const navigationIntent = useContext(NavigationIntentContext);
  return <nav className="research-tabs" aria-label="Saved research type">
    <Link href="/saved" onNavigate={() => navigationIntent?.begin('/saved')} aria-current={!carousels ? 'page' : undefined}>Reels</Link>
    <Link href="/saved/carousels" onNavigate={() => navigationIntent?.begin('/saved/carousels')} aria-current={carousels ? 'page' : undefined}>Carousels</Link>
  </nav>;
}

export function CarouselCard({ carousel: c, onOpen, onSave, busy }: { carousel: Carousel | CarouselSummary; onOpen: ()=>void; onSave: ()=>void; busy: boolean }) {
  const slideCount = 'slide_count' in c ? c.slide_count : c.slides.length;
  const caption = 'caption_preview' in c ? c.caption_preview : c.caption;
  return <article className="carousel-card">
    <button className="carousel-card-cover" onClick={onOpen} aria-label={'View carousel from @'+c.username}>
      <CarouselImage url={c.thumbnail_url ?? ('slides' in c ? c.slides[0]?.image_url : null) ?? null} alt={'Carousel by @'+c.username}/>
      <span className="carousel-slide-count"><Layers size={14}/>{slideCount ? slideCount+' slides' : 'Carousel'}</span>
    </button>
    <div className="carousel-card-body"><div className="carousel-card-creator"><Avatar username={c.username} url={c.avatar_url}/><div><strong>@{c.username}</strong><small>{formatDate(c.published_at)}</small></div>
      <button className="icon-button" aria-label={c.saved ? 'Remove saved carousel' : 'Save carousel'} aria-pressed={c.saved} disabled={busy} onClick={onSave}><Bookmark size={18} fill={c.saved ? 'currentColor' : 'none'}/></button>
    </div><button className="carousel-caption-button" onClick={onOpen}>{caption || 'No caption available'}</button>
    <div className="carousel-card-counts"><span title={c.likes_state==='hidden' ? 'Likes hidden by source' : 'Likes'}><Heart size={15}/>{formatCompact(c.latest_likes)}</span><span title="Comments"><MessageCircle size={15}/>{formatCompact(c.latest_comments)}</span><SourceLink url={c.post_url} label="Original carousel" iconOnly/></div>
    <div className="carousel-card-scores"><span title="Interactions divided by the median of up to 30 earlier carousels; minimum 10 comparisons">Profile outlier <strong className={qualifiesOutlier(c.profile_outlier_score) ? 'carousel-score-highlight' : ''}>{formatScore(c.profile_outlier_score)}</strong></span><span title="Likes + comments divided by captured followers">Follower engagement <strong>{formatPercent(c.follower_engagement_pct)}</strong></span></div>
    </div>
  </article>;
}

export function Carousels({ workspaceId, notify, savedOnly=false, demo=false }: { workspaceId:string; notify:Notify; savedOnly?:boolean; demo?:boolean }) {
  const router=useRouter(),pathname=usePathname(),params=useSearchParams(),source=params.toString();
  const navigationGuard=useNavigationQueryGuard(pathname);
  const navigationIntent=useContext(NavigationIntentContext);
  const [draft,setDraft]=useState<{source:string;target:string;query:CarouselQuery;epoch:number}|null>(null);
  let query: CarouselQuery={},queryError='';
  try {query=draft && draft.epoch===navigationGuard.epoch && (source===draft.source || source===draft.target) ? draft.query : readCarouselQuery(new URLSearchParams(source));} catch (error) {queryError=errorMessage(error);}
  const activeFilterCount = carouselActiveFilterCount(query, savedOnly);
  const scoped={...query,...(savedOnly ? {saved:true} : {}),page:query.page ?? 1,limit:30};
  const base='/api/workspaces/'+workspaceId+'/carousels';
  const listPath='/api/workspaces/'+workspaceId+'/carousel-summaries?'+carouselQueryString(scoped);
  const resource=useResource<PageResult<CarouselSummary>>(queryError ? null : listPath);
  const collectionChannels=useResource<import('@/lib/types').CreatorDirectoryEntry[]>(savedOnly || demo || queryError ? null : '/api/workspaces/'+encodeURIComponent(workspaceId)+'/creator-directory');
  const collectionIds=query.creator_ids ?? (query.creator ? [query.creator] : undefined);
  const collectionCount=collectionIds?.length ?? collectionChannels.data?.length;
  const selectionRequired=collectionCount !== undefined && collectionCount>120;
  const [collectionNotice,setCollectionNotice]=useState('');
  function reloadLibrary() {
    invalidateResources(listPath);
    if (!savedOnly && !demo) invalidateResources(base+'/collection-status');
  }
  const [selected,setSelected]=useState<string|null>(null),[collecting,setCollecting]=useState(false),[pending,setPending]=useState<string[]>([]);
  const pendingRef=useRef(new Set<string>());
  function apply(next: CarouselQuery) {
    if (!navigationGuard.canCommit()) return;
    const target=carouselQueryString(next);setDraft({source,target,query:next,epoch:navigationGuard.epoch});router.replace(pathname+(target ? '?'+target : ''),{scroll:false});
  }
  async function toggleSave(c: CarouselSummary) {
    if (pendingRef.current.has(c.id)) return;pendingRef.current.add(c.id);setPending([...pendingRef.current]);
    try {await api(base+'/'+c.id+'/saved',{method:'PUT',body:JSON.stringify({saved:!c.saved,note:c.note,tags:c.tags})});notify(c.saved ? 'Carousel removed from saved research.' : 'Carousel saved to this workspace.');}
    catch(error) {notify(errorMessage(error),'error');} finally {pendingRef.current.delete(c.id);setPending([...pendingRef.current]);}
  }
  async function collect() {
    if (collecting || demo || queryError) return;setCollecting(true);
    try {
      const creatorIds = query.creator_ids ?? (query.creator ? [query.creator] : undefined);
      if (creatorIds?.length === 0) throw new Error('Choose at least one channel to collect carousels.');
      if (selectionRequired) throw new Error('Choose up to 120 channels in the Channels filter before collecting. No collection was requested.');
      const result=await api<import('@/lib/server/repository').RefreshResult>(base+'/refresh',{method:'POST',body:JSON.stringify(creatorIds ? {creator_ids:creatorIds} : {})});
      const warning=result.processing==='configuration_required' || result.processing==='blocked';
      const message=result.processing==='configuration_required' ? 'Carousel jobs preserved. Processing configuration is required; no new posts have been fetched by this request.' : result.processing==='blocked' ? result.message || 'Carousel collection is blocked. Check Jobs and collection setup.' : result.message;
      setCollectionNotice(message);notify(message,warning ? 'error' : 'success');
    }
    catch(error) {const message=errorMessage(error);setCollectionNotice(message);notify(message,'error');} finally {setCollecting(false);}
  }
  return <>
    <div className="page-heading"><div><h1>{savedOnly ? 'Saved research' : 'Carousels'}</h1></div>
      <div className="row-actions"><button className="button button-secondary" onClick={reloadLibrary} disabled={!!queryError || resource.loading || resource.refreshing} title="Read stored carousel data again without requesting paid collection">Reload library</button>
      {!savedOnly && <button className="button button-secondary" onClick={collect} disabled={collecting || demo || !!queryError || selectionRequired || collectionIds?.length===0} title={demo ? 'Collection is disabled in the synthetic demo' : 'Request paid background collection for up to 120 channels; this does not reload stored data'}><RefreshCw size={15} className={collecting ? 'spin' : ''}/>{collecting ? 'Queuing…' : selectionRequired ? 'Choose up to 120 channels' : 'Collect carousels'}</button>}</div>
    </div>
    {collectionNotice && <p className="collection-notice" role="status">{collectionNotice}</p>}
    {savedOnly && <ResearchTabs carousels/>}
    <div className="reel-explorer-layout">
      <aside className="reel-filter-sidebar" aria-label="Carousel filters"><CarouselFilters key={navigationGuard.epoch} workspaceId={workspaceId} value={query} onChange={apply} notify={notify} savedOnly={savedOnly}/></aside>
      <section className="reel-explorer-results" aria-label={savedOnly ? 'Saved carousel results' : 'Carousel results'}>
        <div className="results-toolbar"><span>{resource.loading ? 'Finding carousels…' : <><strong>{formatNumber(resource.data?.total ?? 0)}</strong> {savedOnly ? 'saved carousels' : 'carousels found'}{activeFilterCount > 0 && ' · filtered'}</>}</span>
          <div><label className="sort-field">Sort by<select aria-label="Sort carousels" value={query.sort ?? 'latest'} onChange={e=>apply({...query,sort:e.target.value as CarouselQuery['sort'],page:1})}><option value="latest">Newest first</option><option value="likes">Most likes</option><option value="comments">Most comments</option><option value="profile_outlier">Profile outlier</option><option value="follower_engagement">Follower engagement</option></select></label></div>
        </div>
    {queryError ? <ErrorState message={queryError} retry={()=>apply({})}/> : resource.loading ? <Skeleton cards/> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={() => invalidateResources(listPath)}/> : <>
      {resource.error && <p className="inline-error" role="status">Update failed: {resource.error} <button className="text-link" onClick={() => invalidateResources(listPath)}>Retry</button></p>}
      {resource.data?.items.length ? <div className="reel-grid carousel-grid">{resource.data.items.map(c=><CarouselCard key={c.id} carousel={c} busy={pending.includes(c.id)} onSave={()=>void toggleSave(c)} onOpen={()=>setSelected(c.id)}/>)}</div>
        : <Empty title={savedOnly ? 'No saved carousels match' : 'No carousels match'} description={savedOnly ? 'Save a carousel from the Carousels page or clear these filters.' : 'Clear your filters, or collect carousels for competitors in this workspace.'} action={savedOnly ? <Link className="button button-secondary" href="/carousels" onNavigate={() => navigationIntent?.begin('/carousels')}>Explore carousels</Link> : <button className="button button-secondary" onClick={()=>apply({})}>Clear filters</button>}/>}
      {resource.data && <ReelPagination itemLabel="carousels" page={scoped.page} limit={30} count={resource.data.items.length} total={resource.data.total} loading={resource.refreshing} onPage={page=>apply({...query,page})}/>}
    </>}
      </section>
    </div>
    {selected && <CarouselDialog key={selected} id={selected} workspaceId={workspaceId} notify={notify} onClose={()=>setSelected(null)}/>}
  </>;
}
