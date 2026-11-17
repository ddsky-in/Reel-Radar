'use client';

import { Activity, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, FileUp, Plus, RefreshCw, Search, Trash2, Users } from 'lucide-react';
import { api, errorMessage } from '@/lib/client';
import { invalidateResources } from '@/lib/resource-cache';
import type { Bootstrap, Creator, CreatorCollectionSummary, CreatorDirectoryEntry, PageResult, Reel, ReelQuery } from '@/lib/types';
import { defaultReelFilters, reelQueryString } from '@/lib/reel-filters';
import { appPath } from '@/lib/app-navigation';
import { creatorAvatarPath } from '@/lib/creator-avatar';
import { carouselQueryString } from '@/lib/carousels';
import type { ImportResult } from '@/lib/server/repository';
import { formatCompact, formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { Avatar, Dialog, Empty, ErrorState, Skeleton, SourceLink, Status, SubmitButton, useResource, type Notify } from './ui';
import { ReelCard } from './reels';
import { saveReel } from '@/lib/reel-save';
import { activeFilterItems, ReelFilters, ReelPagination, filterLink } from './reel-filters';
import { BulkAddCreators } from './bulk-add-creators';
import { CreatorSourceRefresh } from './creator-source-refresh';
import { ReelListContext } from './reel-navigation';
import { RemoveCompetitors } from './remove-competitors';
import { CollectionStatus } from './collection-status';

import { profileCollectionLabel } from '@/lib/collection-status';

import { competitorProgress } from '@/lib/competitor-progress';
import type { JobStatus } from '@/lib/types';

const pendingInitial = new Set(['pending', 'dispatching', 'running', 'processing']);
function initialImportLabel(creator: Creator): string | null {
  const status = creator.initial_backfill_status;
  if (!status) return null;
  if (pendingInitial.has(status)) return 'Initial import: up to 100 Reels · ' + status;
  if (['budget_paused', 'blocked', 'not_queued', 'disabled'].includes(status)) return 'Initial import awaiting budget or server setup';
  if (['failed', 'uncertain'].includes(status)) return 'Initial import needs attention · see Jobs';
  if (status === 'partial') return 'Initial import partially completed · see Jobs';
  return 'Initial import completed';
}

export function Competitors({ workspaceId, workspaceName, mode, notify, refresh }: { workspaceId: string; workspaceName: string; mode?: Bootstrap['mode']; notify: Notify; refresh: (creatorIds?: string[]) => Promise<void> }) {
  const [search, setSearch] = useState(''), [dialog, setDialog] = useState<'add' | 'bulk' | 'import' | null>(null), [selected, setSelected] = useState<Creator | null>(null);
  const [remove, setRemove] = useState<CreatorDirectoryEntry[] | null>(null);
  const [checkedDraft, setChecked] = useState<CreatorDirectoryEntry[]>([]);
  const [committedSearch, setCommittedSearch] = useState(''), [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => { setCommittedSearch(search.trim()); setPage(1); }, 350);
    return () => clearTimeout(timer);
  }, [search]);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const params = new URLSearchParams({ search: committedSearch, page: String(page), limit: '50' });
  const listPath = `${base}/competitors?${params}`;
  const directoryPath = `${base}/creator-directory`;
  const collectionPath = `${base}/collection-summary`;
  const resource = useResource<PageResult<Creator>>(listPath);
  const directory = useResource<CreatorDirectoryEntry[]>(directoryPath);
  const collection = useResource<CreatorCollectionSummary>(collectionPath);
  const directoryReady = directory.data !== null && !directory.loading && !directory.refreshing && !directory.error;
  const tracked = new Map(directory.data?.map(creator => [creator.id, creator]));
  // Only a successful full directory can establish removal. Page absence and
  // failed/loading metadata reads must not discard selected identities.
  const checked = directoryReady
    ? checkedDraft.filter(creator => tracked.has(creator.id)).map(creator => tracked.get(creator.id)!)
    : checkedDraft;
  const checkedIds = new Set(checked.map(creator => creator.id));
  const creators = resource.data?.items ?? [];
  const visibleChecked = creators.filter(creator => checkedIds.has(creator.id)).length;
  const allVisibleChecked = creators.length > 0 && visibleChecked === creators.length;
  const hiddenChecked = checked.length - visibleChecked;

  // Reconcile this component's state before committing children, so a stale
  // selection/page is never briefly exposed by a follow-up effect render.
  if (directoryReady && (checked.length !== checkedDraft.length || checked.some((creator, index) => {
    const previous = checkedDraft[index];
    return creator.id !== previous.id || creator.username !== previous.username || creator.display_name !== previous.display_name
      || creator.avatar_url !== previous.avatar_url || creator.status !== previous.status;
  }))) setChecked(checked);

  if (resource.data && !resource.loading && !resource.refreshing && !resource.error && resource.data.page === page) {
    const lastPage = Math.max(1, Math.ceil(resource.data.total / 50));
    if (page > lastPage) setPage(lastPage);
  }

  function selectionEntry({ id, username, display_name, avatar_url, status }: CreatorDirectoryEntry): CreatorDirectoryEntry {
    return { id, username, display_name, avatar_url, status };
  }

  function selectVisible(select: boolean) {
    const visibleIds = new Set(creators.map(creator => creator.id));
    setChecked(items => select
      ? [...new Map([...items, ...creators.map(selectionEntry)].map(creator => [creator.id, creator])).values()]
      : items.filter(creator => !visibleIds.has(creator.id)));
  }

  function removed(creatorIds: string[]) {
    const ids = new Set(creatorIds);
    setChecked(items => items.filter(creator => !ids.has(creator.id)));
    setSelected(creator => creator && ids.has(creator.id) ? null : creator);
    // The successful mutation already invalidates list/directory dependencies.
    // Clamp from its refreshed total, never from the number of deleted IDs:
    // those IDs can be off-page or excluded by the current search.
  }
  return <>
    <div className="page-heading"><div><h1>Competitors</h1></div><div className="heading-actions"><button className="button button-secondary" onClick={() => setDialog('import')}><FileUp size={16}/>Import CSV</button><button className="button button-secondary" onClick={() => setDialog('bulk')}><Users size={16}/>Bulk add</button><button className="button button-accent" onClick={() => setDialog('add')}><Plus size={17}/>Add competitor</button></div></div>
    {collection.data && <CollectionStatus state={collection.data}/>}
    {collection.error && <p className="inline-error" role="status">Collection status unavailable. Saved research remains available. <button className="text-link" onClick={() => invalidateResources(collectionPath)}>Retry status check</button></p>}
    <div className="panel">
      <div className="manager-toolbar">
        <label className="search-field"><Search size={17}/><input type="search" aria-label="Search competitors" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search your competitors…"/></label>
        <div><span>{directory.data?.length ?? resource.data?.total ?? 0} tracked accounts</span></div>
      </div>
      {directory.error && <p className="inline-error" role="status">Competitor directory unavailable. Your selection is preserved. <button className="text-link" onClick={() => invalidateResources(directoryPath)}>Retry competitor directory</button></p>}
      {checked.length > 0 && <div className="competitor-selection-toolbar">
        <span role="status">{checked.length} selected{hiddenChecked > 0 ? ` · ${hiddenChecked} outside this page` : ''}</span>
        <div>
          <button type="button" className="button button-secondary" onClick={() => setChecked([])}>Clear selection</button>
          <button type="button" className="button button-secondary" disabled={checked.length > 120} title={checked.length > 120 ? 'Refresh supports up to 120 selected competitors at once.' : undefined} onClick={() => refresh(checked.map(creator => creator.id))}><RefreshCw size={14} aria-hidden="true"/>Refresh {checked.length} selected</button>
          <button type="button" className="button button-danger" onClick={() => setRemove(checked)}><Trash2 size={15} aria-hidden="true"/>Delete selected ({checked.length})</button>
        </div>
      </div>}
      {resource.error && resource.data && <p className="inline-error" role="status">Background update failed: {resource.error} <button className="text-link" onClick={() => invalidateResources(listPath)}>Retry</button></p>}
      {resource.loading ? <Skeleton/> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={() => invalidateResources(listPath)}/> : !creators.length ? <Empty title={search ? 'No matching competitors' : 'No competitors'} description={search ? 'Try a different username or display name.' : 'Add a public Instagram profile, paste a list, or import a CSV.'} action={<button className="button button-accent" onClick={() => setDialog('add')}><Plus size={16}/>Add a competitor</button>}/> : <div className="table-scroll">
        <table className="data-table competitor-table">
          <thead><tr>
            <th><input type="checkbox" aria-label="Select all visible competitors" checked={allVisibleChecked} ref={input => { if (input) input.indeterminate = visibleChecked > 0 && !allVisibleChecked; }} onChange={event => selectVisible(event.target.checked)}/></th>
            <th>Creator</th><th>Followers</th><th>Reels</th><th>Carousels</th><th>Last fetch</th><th>Status</th><th><span className="sr-only">Actions</span></th>
          </tr></thead>
          <tbody>{creators.map((creator, i) => <tr key={creator.id} aria-selected={checkedIds.has(creator.id)}>
            <td><input type="checkbox" aria-label={`Select ${creator.username}`} checked={checkedIds.has(creator.id)} onChange={event => setChecked(items => event.target.checked ? [...items.filter(item => item.id !== creator.id), selectionEntry(creator)] : items.filter(item => item.id !== creator.id))}/></td>
            <td><div className="competitor-profile-cell"><button className="creator-cell" onClick={() => setSelected(creator)}><Avatar username={creator.username} index={i} url={creator.avatar_url} fallbackUrl={mode === 'supabase' ? creatorAvatarPath(workspaceId, creator.id) : null}/><span><strong>{creator.display_name || creator.username}</strong><small>@{creator.username}</small></span></button>{mode === 'supabase' && <SourceLink url={`https://www.instagram.com/${encodeURIComponent(creator.username)}/`} label={`Open @${creator.username} on Instagram (new tab)`} iconOnly/>}</div></td>
            <td title={formatNumber(creator.followers_count)}>{formatCompact(creator.followers_count)}</td><td>{formatNumber(creator.tracked_reels ?? 0)}</td><td>{creator.tracked_carousels === undefined ? <span className="block-muted" title="Stored carousel count is unavailable until the creator read migration is applied.">—<span className="sr-only">Carousel count unavailable for @{creator.username}</span></span> : <Link className="competitor-carousel-link" href={`${appPath('carousels')}?${carouselQueryString({ creator: creator.id })}`} aria-label={`View ${formatNumber(creator.tracked_carousels)} stored carousels for @${creator.username}`}>{formatNumber(creator.tracked_carousels)}<ArrowUpRight size={12} aria-hidden="true"/></Link>}</td><td title={formatDateTime(creator.last_reels_fetch_at)}><span>{formatDate(creator.last_reels_fetch_at)}</span>{creator.last_reels_fetch_at && <small className="block-muted">{formatDateTime(creator.last_reels_fetch_at).split(', ').slice(1).join(', ')}</small>}</td>
            <td><CompetitorStatus creator={creator} profileStatus={creator.profile_job_status} open={() => setSelected(creator)}/></td>
            <td><div className="table-actions"><button className="icon-button" title="Refresh creator" aria-label={`Refresh ${creator.username}`} onClick={() => refresh([creator.id])}><RefreshCw size={15}/></button><button className="icon-button" aria-label={`Remove ${creator.username} from workspace`} onClick={() => setRemove([creator])}><Trash2 size={15}/></button></div></td>
          </tr>)}</tbody>
        </table>
      </div>}
      {resource.data && <ReelPagination itemLabel="competitors" page={page} limit={50} count={creators.length} total={resource.data.total} loading={resource.refreshing} onPage={setPage}/>}
    </div>
    {dialog === 'add' && <AddCompetitor base={base} notify={notify} close={() => setDialog(null)} updated={() => {}}/>}
    {dialog === 'bulk' && <BulkAddCreators base={base} workspaceName={workspaceName} notify={notify} close={() => setDialog(null)} updated={() => {}}/>}
    {dialog === 'import' && <ImportCompetitors base={base} notify={notify} close={() => setDialog(null)} updated={() => {}}/>}
    {selected && <SelectedCreator base={base} selected={selected} mode={mode} notify={notify} refresh={refresh} close={() => setSelected(null)}/>}
    {remove && <RemoveCompetitors base={base} workspaceName={workspaceName} creators={remove} notify={notify} close={() => setRemove(null)} removed={removed}/>}
  </>;
}

export function SelectedCreator({ base, selected, mode, notify, refresh, close }: { base: string; selected: Creator; mode?: Bootstrap['mode']; notify: Notify; refresh: (creatorIds?: string[]) => Promise<void>; close: () => void }) {
  const path = `${base}/creators/${encodeURIComponent(selected.id)}`;
  const resource = useResource<Creator>(path);
  const workspaceId = decodeURIComponent(base.split('/')[3]);
  const retry = () => invalidateResources(path);
  if (resource.error && !resource.data) return <Dialog title={selected.display_name || selected.username} onClose={close}><ErrorState message={resource.error} retry={retry}/></Dialog>;
  const creator = resource.data ?? selected;
  return <CreatorDetail key={`${workspaceId}-${creator.id}-${mode ?? 'unknown'}`} creator={creator} profileStatus={creator.profile_job_status} profileError={resource.error} retryProfile={retry} workspaceId={workspaceId} mode={mode} notify={notify} refresh={refresh} close={close}/>;
}

export function CompetitorStatus({ creator, profileStatus, open }: { creator: Creator; profileStatus?: JobStatus; open: () => void }) {
  const progress = competitorProgress(creator, profileStatus);
  return <button type="button" className="competitor-status-button" onClick={open} aria-label={`View ${creator.username} collection details: ${progress.label}`}><span className={`status status-${progress.tone}`}><i/>{progress.label}</span></button>;
}

function AddCompetitor({ base, notify, close, updated }: { base: string; notify: Notify; close: () => void; updated: () => void }) {
  const [username, setUsername] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const creator = await api<Creator>(`${base}/creators`, { method: 'POST', body: JSON.stringify({ username }) }); notify(creator.message ?? (creator.initial_backfill_job_id ? 'Profile added. Initial import queued: up to 100 recent available Reels.' : 'Profile added to your workspace.')); updated(); close(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <Dialog title="Add competitor" onClose={close}><form onSubmit={submit}><label className="field">Instagram username or profile URL<input autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} placeholder="@username or instagram.com/username" required maxLength={250}/></label><p className="helper-copy">Public profiles only. When authorized, new profiles queue up to 100 recent available Reels and an initial window of up to 50 recent photo posts; only carousels are kept. No full carousel history scan. Shared profiles reuse existing data.</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button button-secondary" onClick={close}>Cancel</button><SubmitButton busy={busy}>Add competitor</SubmitButton></div></form></Dialog>;
}

function ImportCompetitors({ base, notify, close, updated }: { base: string; notify: Notify; close: () => void; updated: () => void }) {
  const [csv, setCsv] = useState(''), [preview, setPreview] = useState<ImportResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [committed, setCommitted] = useState(false);
  async function process(commit = false) {
    setBusy(true); setError('');
    try { const result = await api<ImportResult>(`${base}/creators/import`, { method: 'POST', body: JSON.stringify({ csv, preview: !commit }) }); setPreview(result); if (commit) { setCommitted(true); updated(); notify(`Imported ${result.added} accounts. ${result.duplicates} duplicates and ${result.invalid} invalid rows skipped.${result.message ? ' ' + result.message : ''}`); } }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <Dialog title="Import competitors" onClose={close} wide><label className="upload-zone"><FileUp size={24}/><strong>Choose a CSV file</strong><span>Or paste below · username required · workspace optional</span><input type="file" accept=".csv,text/csv" aria-label="Upload competitor CSV" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 1024 * 1024) { setError('Please use a CSV smaller than 1 MB.'); return; } setCsv(await file.text()); setPreview(null); setCommitted(false); }}/></label><label className="field">CSV content<textarea rows={6} value={csv} onChange={event => { setCsv(event.target.value); setPreview(null); setCommitted(false); }} placeholder={'username,workspace\n@creator_one,AI Tools\nhttps://instagram.com/creator_two,AI Tools'}/></label><p className="helper-copy">Public profiles only; workspace names are validated server-side. Preview adds no profiles and starts no collection. When authorized, commit queues up to 100 recent available Reels and an initial 50-photo-post carousel window per new profile. Single-image posts are skipped; no full carousel history scan. Shared profiles reuse existing data.</p>{error && <p className="inline-error" role="alert">{error}</p>}{preview && <div className="import-preview"><div className="import-summary"><span>{committed ? preview.added : preview.rows.filter(row => row.status === 'ready').length} {committed ? 'added' : 'ready'}</span><span>{preview.duplicates} duplicates</span><span>{preview.invalid} invalid</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Row</th><th>Username</th><th>Workspace</th><th>Validation</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.row}><td>{row.row}</td><td>{row.username ?? row.input}</td><td>{row.workspace}</td><td><Status status={row.status}/>{row.error && <small className="block-muted">{row.error}</small>}</td></tr>)}</tbody></table></div></div>}<div className="dialog-actions"><button className="button button-secondary" onClick={close}>{committed ? 'Done' : 'Cancel'}</button>{!committed && <>{preview && <button className="button button-secondary" disabled={busy} onClick={() => process()}>Preview again</button>}<SubmitButton busy={busy} disabled={!csv.trim() || Boolean(preview && !preview.rows.some(row => row.status === 'ready'))} onClick={() => process(Boolean(preview))}>{preview ? 'Commit import' : 'Preview import'}</SubmitButton></>}</div></Dialog>;
}

export function CreatorDetail({ creator, profileStatus, profileError, retryProfile, workspaceId, mode, notify, refresh, close }: { creator: Creator; profileStatus?: JobStatus; profileError?: string | null; retryProfile?: () => void; workspaceId: string; mode?: Bootstrap['mode']; notify: Notify; refresh: (creatorIds?: string[]) => Promise<void>; close: () => void }) {
  const [revision, setRevision] = useState(0), [page, setPage] = useState(1);
  const [filters, setFilters] = useState<ReelQuery>(() => defaultReelFilters());
  const [showCollection, setShowCollection] = useState(false), [showFilters, setShowFilters] = useState(false);
  const query = { ...filters, creator_id: creator.id, sort: filters.sort ?? 'published_at', limit: 30, page };
  const resource = useResource<PageResult<Reel>>(`/api/workspaces/${workspaceId}/reels?${reelQueryString(query)}`, revision);
  async function save(reel: Reel) {
    try { if (await saveReel(workspaceId, reel)) notify(reel.saved ? 'Bookmark removed.' : 'Reel saved.'); } catch (error) { notify(errorMessage(error), 'error'); }
  }
  const progress = competitorProgress(creator, profileStatus);
  const filtersActive = activeFilterItems(filters, { creatorId: creator.id }).length > 0;
  return <ReelListContext.Provider value={query}><Dialog title={creator.display_name || creator.username} subtitle={`@${creator.username}`} onClose={close} wide className="creator-detail-dialog">
    <section className="creator-profile-summary" aria-label="Creator overview">
      <div className="creator-profile-identity"><Avatar username={creator.username} url={creator.avatar_url} fallbackUrl={mode === 'supabase' ? creatorAvatarPath(workspaceId, creator.id) : null}/><span className={`status status-${progress.tone}`}><i/>{progress.label}</span></div>
      <dl className="creator-profile-stats"><div><dt>Followers</dt><dd>{formatCompact(creator.followers_count)}</dd></div><div><dt>Reels tracked</dt><dd>{formatNumber(creator.tracked_reels ?? 0)}</dd></div><div><dt>Carousels tracked</dt><dd>{creator.tracked_carousels === undefined ? '—' : <Link className="text-link" href={`${appPath('carousels')}?${carouselQueryString({ creator: creator.id })}`} onClick={close}>{formatNumber(creator.tracked_carousels)}</Link>}</dd></div><div><dt>Latest Reel</dt><dd>{formatDate(creator.latest_reel_date)}</dd></div></dl>
      <div className="creator-profile-actions"><SourceLink url={mode === 'supabase' && (creator.last_profile_fetch_at || creator.last_reels_fetch_at) ? `https://www.instagram.com/${creator.username}/` : null} label="Instagram profile"/><button className="button button-secondary" onClick={() => refresh([creator.id])}><RefreshCw size={14}/>Refresh creator</button></div>
      {profileError && <p className="inline-error" role="status">Profile update failed: {profileError} {retryProfile && <button className="text-link" onClick={retryProfile}>Retry profile check</button>}</p>}
    </section>
    <details className="creator-collection-details" onToggle={event => setShowCollection(event.currentTarget.open)}><summary>Collection details{creator.last_error || progress.tone === 'failed' || progress.tone === 'uncertain' ? ' · needs review' : ''}</summary><div className="creator-collection-body">
      <dl className="creator-collection-meta"><div><dt>Profile update</dt><dd>{profileCollectionLabel(profileStatus) ?? 'Not fetched'}</dd></div><div><dt>Initial Reel import</dt><dd>{initialImportLabel(creator) ?? 'Not queued'}</dd></div><div><dt>Followers captured</dt><dd>{formatDateTime(creator.last_profile_fetch_at)}</dd></div><div><dt>Last Reel fetch</dt><dd>{formatDateTime(creator.last_reels_fetch_at)}</dd></div></dl>
      {creator.last_error && <p className="inline-error">{creator.last_error}</p>}<Link className="text-link" href={appPath('jobs')}>View collection jobs</Link>
      {showCollection && <CreatorSourceRefresh key={creator.id} workspaceId={workspaceId} creatorId={creator.id} notify={notify}/>}
    </div></details>
    <div className="creator-reels-toolbar"><h3>Reels</h3><span>{resource.data ? `${formatNumber(resource.data.total)} ${filtersActive ? 'matching' : 'available'}` : 'Loading…'}</span><Link className="text-link" href={`${appPath('reels')}?${filterLink(query)}`} onClick={close}>Open explorer<ArrowUpRight size={14}/></Link></div>
    {/* Preserve uncommitted drafts; hidden Activity cleans up debounce effects. */}
    <details className="creator-filter-details" open={showFilters} onToggle={event => setShowFilters(event.currentTarget.open)}><summary>Filter Reels{filtersActive ? ' · active' : ''}</summary><Activity mode={showFilters ? 'visible' : 'hidden'}><ReelFilters workspaceId={workspaceId} value={query} onChange={next => { setFilters(next); setPage(1); }} notify={notify} lockedCreator={creator} enabled={showFilters}/></Activity></details>
    {resource.error && resource.data && <p className="inline-error" role="status">Background update failed: {resource.error} <button className="text-link" onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
    {resource.loading ? <Skeleton cards/> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={() => setRevision(value => value + 1)}/> : !resource.data?.items.length ? <Empty title={filtersActive ? 'No matching Reels' : 'No Reels yet'} description={pendingInitial.has(creator.initial_backfill_status ?? '') ? 'Initial import is queued or processing. Saved Reels will appear here.' : filtersActive ? 'Clear your filters or check collection details.' : 'Check collection details for import status.'}/> : <div className="reel-grid creator-reels">{resource.data.items.map(reel => <ReelCard key={reel.id} workspaceId={workspaceId} reel={reel} onSave={save}/>)}</div>}
    {resource.data && <ReelPagination page={page} limit={30} total={resource.data.total} count={resource.data.items.length} loading={resource.loading} onPage={setPage}/>}<div className="dialog-actions"><button type="button" className="button button-secondary" onClick={close}>Close</button></div>
  </Dialog></ReelListContext.Provider>;
}
