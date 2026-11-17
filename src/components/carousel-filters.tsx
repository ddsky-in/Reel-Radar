'use client';

import { Activity, useId, useState } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import type { CarouselQuery, CreatorDirectoryEntry, SavedCarouselFilter } from '@/lib/types';
import { api, errorMessage } from '@/lib/client';
import { carouselActiveFilterCount, carouselFilterQuerySchema, carouselFilterSchema, carouselQuerySchema } from '@/lib/carousels';
import { ChannelPicker, KeywordFilter, PeriodFilter, RangeFilter, useFilterSidebarVisibility } from './reel-filters';
import { ControlPopover, closeControlPopover, openControlPopover } from './control-popover';
import { Dialog, SubmitButton, useResource, type Notify } from './ui';
import { invalidateResources } from '@/lib/resource-cache';

export function CarouselFilters({ workspaceId, value, onChange, notify, savedOnly = false }: {
  workspaceId: string; value: CarouselQuery; onChange: (value: CarouselQuery) => void; notify: Notify; savedOnly?: boolean;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(true), [showSaved, setShowSaved] = useState(false);
  const { toggleRef, visible } = useFilterSidebarVisibility(expanded);
  const channels = useResource<CreatorDirectoryEntry[]>(visible ? `/api/workspaces/${encodeURIComponent(workspaceId)}/creator-directory` : null);
  const presets = useResource<SavedCarouselFilter[]>(showSaved ? '/api/carousel-filters' : null);
  const [saving, setSaving] = useState(false), [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [remove, setRemove] = useState<SavedCarouselFilter | null>(null), [reset, setReset] = useState(0);
  const available = channels.data ?? [], chosen = value.creator_ids ?? (value.creator ? [value.creator] : undefined);
  const missing = chosen?.filter(channel => !available.some(creator => creator.id === channel)) ?? [];
  const activeCount = carouselActiveFilterCount(value, savedOnly);
  function apply(next: CarouselQuery) {
    try {
      const parsed = carouselQuerySchema.parse({ ...next, ...(savedOnly ? { saved: true } : {}), page: 1 });
      setError(''); onChange(parsed);
    } catch { setError('Please check the carousel filters.'); }
  }
  function change(patch: Partial<CarouselQuery>) { apply({ ...value, ...patch }); }
  function clear() { setReset(current => current + 1); apply({ sort: value.sort, limit: value.limit }); }
  function closeSaved() {
    setShowSaved(false);
    const panel = document.getElementById(`${id}-saved`);
    if (panel) closeControlPopover(panel, document.getElementById(`${id}-saved-trigger`) ?? undefined);
  }
  function toggleSidebar(event: React.MouseEvent<HTMLButtonElement>) {
    if (expanded) {
      setShowSaved(false);
      const section = event.currentTarget.closest('section');
      section?.querySelectorAll<HTMLElement>('[popover]').forEach(panel => closeControlPopover(panel));
      section?.querySelectorAll<HTMLDetailsElement>('.channel-picker').forEach(details => { details.open = false; });
      event.currentTarget.focus();
    }
    setExpanded(current => !current);
  }
  function toggleSaved(event: React.MouseEvent<HTMLButtonElement>) {
    const panel = document.getElementById(`${id}-saved`);
    if (panel) { if (panel.matches(':popover-open')) closeSaved(); else openControlPopover(panel, event.currentTarget); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      const { page: _page, limit: _limit, ...query } = value;
      void _page; void _limit;
      const body = carouselFilterSchema.parse({ name: name.trim(), query });
      await api('/api/carousel-filters', { method: 'POST', body: JSON.stringify(body) });
      setSaving(false); setName(''); notify('Carousel filter saved to your account.');
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function deletePreset() {
    if (!remove || busy) return; setBusy(true); setError('');
    try { await api(`/api/carousel-filters/${encodeURIComponent(remove.id)}`, { method: 'DELETE' }); setRemove(null); notify('Saved carousel filter deleted.'); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <section className={`filter-panel advanced-filters filter-sidebar-panel carousel-filter-panel${expanded ? '' : ' filter-sidebar-collapsed'}`} aria-label="Carousel filter controls">
    <div className="filter-saved-heading"><strong>Saved filters</strong><button type="button" id={`${id}-saved-trigger`} className="text-button" aria-label={`${showSaved ? 'Hide' : 'Show'} saved carousel filters`} aria-expanded={showSaved} aria-controls={`${id}-saved`} onClick={toggleSaved}>{showSaved ? 'Hide' : 'Show'}</button></div>
    <ControlPopover id={`${id}-saved`} anchorId={`${id}-saved-trigger`} className="saved-filter-list" role="region" aria-label="Saved carousel filters" onOpenChange={setShowSaved}>
      {showSaved && <><strong>Saved filters</strong>
      {presets.loading ? <p className="helper-copy">Loading saved filters…</p> : presets.error ? <p className="inline-error" role="alert">{presets.error} <button type="button" className="text-link" onClick={() => invalidateResources('/api/carousel-filters')}>Retry</button></p> : !presets.data?.length ? <p className="helper-copy">No saved filters yet. Set your filters and choose Save filter.</p> : presets.data.map(preset => <div className="saved-filter-row" key={preset.id}>
        <button type="button" className="text-button" onClick={() => { setReset(current => current + 1); apply(carouselFilterQuerySchema.parse(preset.config.query)); closeSaved(); }}>{preset.name}<span>Apply</span></button>
        <button type="button" className="icon-button" aria-label={`Delete saved carousel filter ${preset.name}`} onClick={() => { closeSaved(); setError(''); setRemove(preset); }}><Trash2 size={14}/></button>
      </div>)}</>}
    </ControlPopover>
    <div className="advanced-filter-heading"><strong>Filters{activeCount > 0 && <span className="filter-active-count" aria-label={`${activeCount} active filter${activeCount === 1 ? '' : 's'}`}>{activeCount}</span>}</strong><div>
      <button type="button" className="text-button" aria-label="Clear carousel filters" onClick={clear}>Clear</button>
      <button type="button" ref={toggleRef} className="text-button filter-sidebar-toggle" aria-expanded={visible} aria-controls={`${id}-content`} onClick={toggleSidebar}>{expanded ? <ChevronUp size={16} aria-hidden="true"/> : <ChevronDown size={16} aria-hidden="true"/>}{expanded ? 'Hide filters' : 'Show filters'}</button>
    </div></div>
    <div className="filter-sidebar-content" id={`${id}-content`} hidden={!visible}><Activity mode={visible ? 'visible' : 'hidden'}>
      <div className="channel-filter"><span className="filter-label">Channels</span><ChannelPicker id={`${id}-channels`} creators={available} selected={chosen} loading={channels.loading} onChange={creator_ids => change({ creator: undefined, creator_ids })}/></div>
      {channels.error && <p className="inline-error" role="status">Channels could not be updated: {channels.error} <button type="button" className="text-link" onClick={() => invalidateResources(`/api/workspaces/${encodeURIComponent(workspaceId)}/creator-directory`)}>Retry</button></p>}
      {missing.length > 0 && <p className="helper-copy" role="status">{missing.length} selected channel(s) are unavailable in this workspace. Use All channels to reset.</p>}
      <div className="advanced-filter-fields" key={reset}>
        <div className="filter-group"><div className="advanced-filter-metrics">
          <div title="Likes + comments divided by captured followers. This is the carousel follower outlier."><RangeFilter compact label="Outlier Score" unit="x" minimum={0} maximum={100} low={value.min_outlier} high={value.max_outlier} onChange={(min_outlier, max_outlier) => change({ min_outlier, max_outlier })}/></div>
          <div title="Interactions divided by the median of up to 30 earlier carousels, with at least 10 comparisons."><RangeFilter compact label="Profile Outlier Score" unit="x" minimum={0} maximum={1_000_000} low={value.min_profile_outlier} high={value.max_profile_outlier} onChange={(min_profile_outlier, max_profile_outlier) => change({ min_profile_outlier, max_profile_outlier })}/></div>
          <div title="Likes + comments divided by captured followers, expressed as a percentage."><RangeFilter compact label="Engagement" unit="%" minimum={0} maximum={100} low={value.min_engagement} high={value.max_engagement} onChange={(min_engagement, max_engagement) => change({ min_engagement, max_engagement })}/></div>
        </div></div>
        <div className="filter-group"><div className="advanced-filter-search">
          <PeriodFilter compact value={{ posted_amount: value.posted_amount, posted_unit: value.posted_unit }} onChange={({ posted_amount, posted_unit }) => change({ posted_amount, posted_unit })}/>
          <KeywordFilter compact carousel value={value.keywords ?? value.search ?? ''} onChange={keywords => change({ search: undefined, keywords: keywords || undefined })}/>
        </div></div>
      </div>
      {value.min_interactions !== undefined && <p className="helper-copy" role="status">Minimum interactions: {value.min_interactions.toLocaleString()} <button type="button" className="text-link" onClick={() => change({ min_interactions: undefined })}>Remove</button></p>}
      {!savedOnly && <label className="checkbox-field"><input type="checkbox" checked={value.saved === true} onChange={event => change({ saved: event.target.checked || undefined })}/>Saved only</label>}
      <button type="button" className="button button-accent filter-sidebar-save" onClick={() => { setName(''); setError(''); setSaving(true); }}>Save filter</button>
      {error && !saving && !remove && <p className="inline-error" role="alert">{error}</p>}
    </Activity></div>
    {saving && <Dialog title="Save carousel filter" onClose={() => !busy && setSaving(false)}><form onSubmit={save}>
      <label className="field">Filter name<input autoFocus required maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="e.g. Strong hooks this month"/></label>
      <p className="helper-copy">Reuse this combination across your Carousels sections. The time period stays rolling.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setSaving(false)}>Cancel</button><SubmitButton busy={busy} disabled={!name.trim()}>Save filter</SubmitButton></div>
    </form></Dialog>}
    {remove && <Dialog title="Delete saved carousel filter?" onClose={() => !busy && setRemove(null)}><p className="dialog-copy">Delete “{remove.name}” from your saved filters?</p>
      <div className="dialog-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setRemove(null)}>Cancel</button><SubmitButton busy={busy} onClick={deletePreset}>Delete filter</SubmitButton></div>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </Dialog>}
  </section>;
}
