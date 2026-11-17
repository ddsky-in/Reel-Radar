'use client';

import { Activity, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Save, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import type { Creator, CreatorDirectoryEntry, ReelQuery, SavedReelFilter } from '@/lib/types';
import { api, errorMessage } from '@/lib/client';
import { defaultReelFilters, reelQueryString, resolveReelPeriod, validateReelFilterQuery } from '@/lib/reel-filters';
import { Avatar, Dialog, SubmitButton, useResource, type Notify } from './ui';
import { DatePicker } from './date-picker';
import { ControlPopover, openControlPopover, closeControlPopover } from './control-popover';

type Props = { workspaceId: string; value: ReelQuery; onChange: (value: ReelQuery) => void; notify: Notify; savedOnly?: boolean; lockedCreator?: Creator; layout?: 'full' | 'sidebar'; enabled?: boolean };

// Desktop CSS restores the sidebar when its research container grows. Observe
// the existing toggle's visibility rather than duplicating that breakpoint.
export function useFilterSidebarVisibility(expanded: boolean) {
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    if (expanded) return;
    const toggle = toggleRef.current;
    if (!toggle) return;
    const update = () => setDesktop(getComputedStyle(toggle).display === 'none');
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(toggle.closest('.content') ?? toggle.parentElement!);
    window.addEventListener('resize', update);
    // Also cover collapse without a resize and browsers without ResizeObserver.
    queueMicrotask(update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [expanded]);
  return { toggleRef, visible: expanded || desktop };
}

export function ReelFilters({ workspaceId, value, onChange, notify, savedOnly = false, lockedCreator, layout = 'full', enabled = true }: Props) {
  const [reset, setReset] = useState(0), [sidebarExpanded, setSidebarExpanded] = useState(true);
  const { toggleRef, visible } = useFilterSidebarVisibility(sidebarExpanded);
  const contentVisible = enabled && (layout !== 'sidebar' || visible);
  const channels = useResource<CreatorDirectoryEntry[]>(contentVisible && !lockedCreator ? `/api/workspaces/${encodeURIComponent(workspaceId)}/creator-directory` : null);
  const [savedExpanded, setShowSaved] = useState(false), [saving, setSaving] = useState(false), [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [remove, setRemove] = useState<SavedReelFilter | null>(null);
  const showSaved = enabled && savedExpanded;
  const presets = useResource<SavedReelFilter[]>(showSaved ? '/api/reel-filters' : null);
  const id = useId();
  const panelRef = useRef<HTMLElement>(null);
  // Activity preserves drafts, but transient top-layer popovers must close when
  // the full panel hides; otherwise they can escape its collapsed details.
  useLayoutEffect(() => () => {
    panelRef.current?.querySelectorAll<HTMLElement>('[popover]').forEach(panel => closeControlPopover(panel));
    setShowSaved(false);
  }, []);
  const available = channels.data ?? [];
  const chosen = value.creator_ids ?? (value.creator_id ? [value.creator_id] : undefined);
  const missing = chosen?.filter(channel => !available.some(item => item.id === channel)) ?? [];
  const compact = layout === 'sidebar';
  const scope = { savedOnly, creatorId: lockedCreator?.id };
  const activeFilters = activeFilterItems(value, scope, available);
  function apply(next: ReelQuery) {
    const scoped = { ...filterScope(next, scope), page: 1 };
    try {
      const { page: _page, limit: _limit, ...criteria } = scoped;
      void _page; void _limit;
      validateReelFilterQuery(criteria);
      resolveReelPeriod(scoped);
      setError(''); onChange(scoped);
    } catch (failure) { setError(errorMessage(failure)); }
  }
  function change(patch: Partial<ReelQuery>) { apply({ ...value, ...patch }); }
  function clear() { setReset(value => value + 1); apply(clearFilterCriteria(value, scope)); }
  function removeFilter(item: ActiveFilterItem) { setReset(value => value + 1); apply(removeFilterCriteria(value, item.keys, scope)); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const { page: _page, limit: _limit, ...query } = value;
    void _page; void _limit;
    try { await api('/api/reel-filters', { method: 'POST', body: JSON.stringify({ name: name.trim(), query }) }); setSaving(false); setName(''); notify('Filter saved to your account.'); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function deletePreset() {
    if (!remove) return; setBusy(true);
    try { await api(`/api/reel-filters/${encodeURIComponent(remove.id)}`, { method: 'DELETE' }); setRemove(null); notify('Saved filter deleted.'); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  function closeSaved() {
    setShowSaved(false);
    const panel = document.getElementById(`${id}-saved`);
    if (panel) closeControlPopover(panel, document.getElementById(`${id}-saved-trigger`) ?? undefined);
  }
  function toggleSidebar(event: React.MouseEvent<HTMLButtonElement>) {
    if (sidebarExpanded) {
      setShowSaved(false);
      const section = event.currentTarget.closest('section');
      section?.querySelectorAll<HTMLElement>('[popover]').forEach(panel => closeControlPopover(panel));
      section?.querySelectorAll<HTMLDetailsElement>('.channel-picker').forEach(details => { details.open = false; });
      event.currentTarget.focus();
    }
    setSidebarExpanded(expanded => !expanded);
  }
  function toggleSaved(event: React.MouseEvent<HTMLButtonElement>) {
    const panel = document.getElementById(`${id}-saved`);
    if (!panel) return;
    if (panel.matches(':popover-open')) closeSaved(); else openControlPopover(panel, event.currentTarget);
  }
  const savedFilters = <ControlPopover id={`${id}-saved`} anchorId={`${id}-saved-trigger`} className="saved-filter-list" role="region" aria-label="Saved filters" onOpenChange={setShowSaved}>{showSaved && <><strong>Saved Filters</strong>{presets.loading ? <p className="helper-copy">Loading saved filters…</p> : presets.error ? <p className="inline-error">{presets.error}</p> : !presets.data?.length ? <p className="helper-copy">No saved filters yet. Set your filters and choose Save Filter.</p> : presets.data.map(preset => <div className="saved-filter-row" key={preset.id}><button type="button" className="text-button" onClick={() => { setReset(value => value + 1); apply(preset.config.query); closeSaved(); }}>{preset.name}<span>Apply</span></button><button type="button" className="icon-button" aria-label={`Delete saved filter ${preset.name}`} onClick={() => { closeSaved(); setRemove(preset); }}><Trash2 size={14}/></button></div>)}</>}</ControlPopover>;
  const filterContent = <>
    {!compact && <div className="filter-active-summary"><span>{activeFilters.length ? `${activeFilters.length} active filter${activeFilters.length === 1 ? '' : 's'}` : 'No active filters'}</span>{savedOnly && <span className="filter-scope">Saved Reels scope</span>}{activeFilters.length > 0 && <div className="filter-chip-list">{activeFilters.map(item => <button type="button" className="filter-chip" key={item.id} aria-label={`Remove ${item.id} filter`} onClick={() => removeFilter(item)}>{item.label}<X size={12} aria-hidden="true"/></button>)}</div>}</div>}
    {compact ? <div className="channel-filter"><span className="filter-label">Channels</span><ChannelPicker id={`${id}-channels`} creators={available} selected={chosen} loading={channels.loading} lockedCreator={lockedCreator} onChange={creator_ids => change({ creator_id: undefined, creator_ids })}/></div> :
    <div className="channel-filter"><span className="filter-label">Channels</span><div className="channel-options" role="group" aria-label="Filter channels">
      {lockedCreator ? <span className="channel-option channel-locked"><Avatar username={lockedCreator.username} url={lockedCreator.avatar_url}/>@{lockedCreator.username}<small>Creator scope</small></span> : <>
        <button type="button" className="channel-option" onClick={() => change({ creator_id: undefined, creator_ids: undefined })}>All channels</button>
        {available.map(creator => <button type="button" className="channel-option" key={creator.id} aria-label={`Filter channel @${creator.username}`} aria-pressed={Boolean(chosen?.includes(creator.id))} onClick={() => { const selected = chosen?.includes(creator.id) ? chosen.filter(channel => channel !== creator.id) : [...chosen ?? [], creator.id]; change({ creator_id: undefined, creator_ids: selected.length ? selected : undefined }); }}><Avatar username={creator.username} url={creator.avatar_url}/><span>@{creator.username}</span>{chosen?.includes(creator.id) && <Check size={14}/>}</button>)}
        {channels.loading && <span className="helper-copy">Loading channels…</span>}
        {chosen?.length === 0 && <span className="helper-copy">No channels selected. Choose a channel or All channels.</span>}
      </>}
    </div></div>}
    {channels.error && <p className="inline-error" role="status">Channel list: {channels.error}</p>}
    {missing.length > 0 && <p className="helper-copy" role="status">{missing.length} selected channel(s) are unavailable in this workspace. Selection remains restricted; use All channels to reset.</p>}
    <div className="advanced-filter-fields" key={reset}>
      <div className="filter-group"><span className={`filter-group-title${compact ? ' sr-only' : ''}`}>Metrics</span><div className="advanced-filter-metrics">
        <RangeFilter compact={compact} label="Outlier Score" unit="x" minimum={0} maximum={100} low={value.min_outlier} high={value.max_outlier} onChange={(min, max) => change({ min_outlier: min, max_outlier: max })}/>
        <RangeFilter compact={compact} label="Profile Outlier Score" unit="x" minimum={0} maximum={1_000_000} low={value.min_profile_outlier} high={value.max_profile_outlier} onChange={(min, max) => change({ min_profile_outlier: min, max_profile_outlier: max })}/>
        <RangeFilter compact={compact} label="Views" minimum={0} maximum={10_000_000} integer low={value.min_views} high={value.max_views} onChange={(min, max) => change({ min_views: min, max_views: max })}/>
        <RangeFilter compact={compact} label="Engagement" unit="%" minimum={0} maximum={100} low={value.min_engagement} high={value.max_engagement} onChange={(min, max) => change({ min_engagement: min, max_engagement: max })}/>
      </div></div>
      <div className="filter-group"><span className={`filter-group-title${compact ? ' sr-only' : ''}`}>Time & keywords</span><div className="advanced-filter-search">
        <PeriodFilter compact={compact} value={value} onChange={change}/>
        <KeywordFilter compact={compact} value={value.keywords ?? ''} onChange={keywords => change({ keywords: keywords || undefined })}/>
      </div></div>
    </div>
    <details className="advanced-filter-more"><summary>More filters</summary><p className={`helper-copy${compact ? ' sr-only' : ''}`} id={`${id}-dates`}>Dates use IST. Select a date from the calendar.</p><div className="filter-expanded">
      <label className={`field${compact ? ' filter-control-compact' : ''}`} title="Published dates are shown in IST">Published from<DatePicker data-filter-active={Boolean(value.from)} aria-label="Published from" aria-describedby={`${id}-dates`} value={value.from ?? ''} onChange={date => change({ from: date || undefined, posted_amount: undefined, posted_unit: undefined })}/></label>
      <label className={`field${compact ? ' filter-control-compact' : ''}`} title="Published dates are shown in IST">Published to<DatePicker data-filter-active={Boolean(value.to)} aria-label="Published to" aria-describedby={`${id}-dates`} value={value.to ?? ''} min={value.from} onChange={date => change({ to: date || undefined, posted_amount: undefined, posted_unit: undefined })}/></label>
      <label className={`field${compact ? ' filter-control-compact' : ''}`}>Freshness<select data-filter-active={Boolean(value.freshness && value.freshness !== 'all')} value={value.freshness ?? 'all'} onChange={event => change({ freshness: event.target.value as ReelQuery['freshness'] })}><option value="all">All snapshots</option><option value="fresh">Fresh (≤48 hours)</option><option value="stale">Stale (&gt;48 hours)</option></select></label>
      <label className={`field${compact ? ' filter-control-compact' : ''}`}>Creator status<select data-filter-active={Boolean(value.status)} value={value.status ?? ''} onChange={event => change({ status: (event.target.value || undefined) as ReelQuery['status'] })}><option value="">All statuses</option>{['active','pending','unavailable','private','failed','paused'].map(status => <option key={status} value={status}>{status}</option>)}</select></label>
      <label className="checkbox-field"><input type="checkbox" checked={savedOnly || Boolean(value.saved)} disabled={savedOnly} onChange={event => change({ saved: event.target.checked || undefined })}/>Saved Reels only</label>
    </div></details>
    {!compact && savedFilters}
    {compact && <button type="button" className="button button-accent filter-sidebar-save" onClick={() => { setName(''); setError(''); setSaving(true); }}>Save filter</button>}
    {error && !saving && <p className="inline-error" role="alert">{error}</p>}
  </>;
  return <section ref={panelRef} className={`filter-panel advanced-filters ${layout === 'sidebar' ? `filter-sidebar-panel${sidebarExpanded ? '' : ' filter-sidebar-collapsed'}` : ''}`} aria-label="Advanced Reel filters">
    {compact && <><div className="filter-saved-heading"><strong>Saved filters</strong><button type="button" id={`${id}-saved-trigger`} className="text-button" aria-label={`${showSaved ? 'Hide' : 'Show'} saved filters`} onClick={toggleSaved} aria-expanded={showSaved} aria-controls={`${id}-saved`}>{showSaved ? 'Hide' : 'Show'}</button></div>{savedFilters}</>}
    <div className="advanced-filter-heading"><strong>{compact ? <>Filters{activeFilters.length > 0 && <span className="filter-active-count" aria-label={`${activeFilters.length} active filter${activeFilters.length === 1 ? '' : 's'}`}>{activeFilters.length}</span>}</> : <><SlidersHorizontal size={16}/>Advanced filters</>}</strong><div>{!compact && <button type="button" id={`${id}-saved-trigger`} className="text-button" onClick={toggleSaved} aria-expanded={showSaved} aria-controls={`${id}-saved`}>Saved Filters · {showSaved ? 'Hide' : 'Show'}</button>}<button type="button" className="text-button" onClick={clear}>Clear</button>{!compact && <button type="button" className="button button-secondary" onClick={() => { setName(''); setError(''); setSaving(true); }}><Save size={14}/>Save Filter</button>}{compact && <button type="button" ref={toggleRef} className="text-button filter-sidebar-toggle" aria-expanded={contentVisible} aria-controls={`${id}-content`} onClick={toggleSidebar}>{sidebarExpanded ? <ChevronUp size={16} aria-hidden="true"/> : <ChevronDown size={16} aria-hidden="true"/>}{sidebarExpanded ? 'Hide filters' : 'Show filters'}</button>}</div></div>
    {layout === 'sidebar' ? <div className="filter-sidebar-content" id={`${id}-content`} hidden={!contentVisible}><Activity mode={contentVisible ? 'visible' : 'hidden'}>{filterContent}</Activity></div> : filterContent}
    {saving && <Dialog title="Save Filter" onClose={() => !busy && setSaving(false)}><form onSubmit={save}><label className="field">Filter name<input autoFocus maxLength={80} required value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="e.g. High engagement this month"/></label><p className="helper-copy">Save this combination to reuse across your Reels sections. The time period stays rolling.</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setSaving(false)}>Cancel</button><SubmitButton busy={busy} disabled={!name.trim()}>Save Filter</SubmitButton></div></form></Dialog>}
    {remove && <Dialog title="Delete saved filter?" onClose={() => !busy && setRemove(null)}><p className="dialog-copy">Delete “{remove.name}”? This only removes the saved combination, not any Reels.</p><div className="dialog-actions"><button className="button button-secondary" disabled={busy} onClick={() => setRemove(null)}>Cancel</button><SubmitButton busy={busy} onClick={deletePreset}>Delete filter</SubmitButton></div>{error && <p className="inline-error" role="alert">{error}</p>}</Dialog>}
  </section>;
}

export function ChannelPicker({ id, creators, selected, loading = false, lockedCreator, onChange }: { id: string; creators: CreatorDirectoryEntry[]; selected?: string[]; loading?: boolean; lockedCreator?: Creator; onChange: (ids?: string[]) => void }) {
  const [expanded, setExpanded] = useState(false), [search, setSearch] = useState('');
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => () => {
    const details = detailsRef.current;
    if (details) {
      const panel = details.querySelector<HTMLElement>('[popover]');
      if (panel) closeControlPopover(panel);
      details.open = false;
    }
    setExpanded(false);
  }, []);
  if (lockedCreator) return <div className="channel-picker-locked channel-option channel-locked" aria-label={`Channel restricted to @${lockedCreator.username}`}><Avatar username={lockedCreator.username} url={lockedCreator.avatar_url}/><span>@{lockedCreator.username}</span></div>;
  const matches = selected === undefined ? creators : creators.filter(creator => selected.includes(creator.id));
  const preview = matches.slice(0, 8);
  const description = selected === undefined ? 'All channels' : selected.length ? `${selected.length} channel${selected.length === 1 ? '' : 's'} selected` : 'No channels selected';
  function close(details: HTMLDetailsElement, focus = false) {
    details.open = false;
    if (focus) details.querySelector('summary')?.focus();
  }
  return <details ref={detailsRef} className="channel-picker" onToggle={event => {
    const details = event.currentTarget, panel = details.querySelector<HTMLElement>('[popover]')!, anchor = details.querySelector<HTMLElement>('summary')!;
    setExpanded(details.open);
    if (details.open) openControlPopover(panel, anchor); else closeControlPopover(panel);
  }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(event.currentTarget, true); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(event.currentTarget); }}>
    <summary id={`${id}-trigger`} className="channel-picker-trigger" data-filter-active={selected !== undefined} aria-label="Filter channels dropdown" aria-describedby={`${id}-selection`} aria-controls={`${id}-menu`} title={description}>
      {preview.length > 0 ? <span className="channel-picker-avatars" aria-hidden="true">{preview.map(creator => <Avatar key={creator.id} username={creator.username} url={creator.avatar_url}/>)}</span> : <span className="channel-picker-label">{loading ? 'Loading channels…' : description}</span>}
      {matches.length > preview.length && <span className="channel-picker-count" aria-hidden="true">+{matches.length - preview.length}</span>}
      <ChevronDown size={14} aria-hidden="true"/>
      <span id={`${id}-selection`} className="sr-only">{description}</span>
    </summary>
    <ControlPopover anchorId={`${id}-trigger`} matchWidth className="channel-picker-menu" id={`${id}-menu`} role="group" aria-label="Filter channels">
      <button type="button" className="channel-option channel-picker-option" aria-pressed={selected === undefined} onClick={() => onChange(undefined)}>All channels{selected === undefined && <Check size={14} aria-hidden="true"/>}</button>
      {expanded && <label className="search-field"><Search size={14}/><input type="search" aria-label="Search channels" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} placeholder="Search channels…"/></label>}
      {expanded && creators.filter(creator => `${creator.username} ${creator.display_name ?? ''}`.toLowerCase().includes(search.toLowerCase())).map(creator => <button type="button" key={creator.id} className="channel-option channel-picker-option" aria-label={`Filter channel @${creator.username}`} aria-pressed={Boolean(selected?.includes(creator.id))} onClick={() => { const next = selected?.includes(creator.id) ? selected.filter(channel => channel !== creator.id) : [...selected ?? [], creator.id]; onChange(next.length ? next : undefined); }}><Avatar username={creator.username} url={creator.avatar_url}/><span>@{creator.username}</span>{selected?.includes(creator.id) && <Check size={14} aria-hidden="true"/>}</button>)}
      {loading && <p className="helper-copy" role="status">Loading channels…</p>}
      {!loading && creators.length === 0 && <p className="helper-copy">No channels in this workspace.</p>}
      {selected?.length === 0 && <p className="helper-copy">No channels selected. Choose a channel or All channels.</p>}
    </ControlPopover>
  </details>;
}

export function RangeFilter({ label, unit = '', minimum, maximum, low, high, integer = false, compact = false, onChange }: { label: string; unit?: string; minimum: number; maximum: number; low?: number; high?: number; integer?: boolean; compact?: boolean; onChange: (low?: number, high?: number) => void }) {
  const id = useId();
  const placeholders = compact ? [String(minimum), `${maximum.toLocaleString('en-US')}${unit}`] : label === 'Views' ? ['e.g. 10000', 'e.g. 1000000'] : label === 'Engagement' ? ['e.g. 2', 'e.g. 10'] : ['e.g. 3', 'e.g. 20'];
  const key = `${low}:${high}`;
  const [draft, setDraft] = useState<{ key: string; low: string; high: string; lowInvalid: boolean; highInvalid: boolean } | null>(null);
  const current = draft?.key === key ? draft : { key, low: low === undefined ? '' : String(low), high: high === undefined ? '' : String(high), lowInvalid: false, highInvalid: false };
  const left = current.low === '' ? undefined : Number(current.low), right = current.high === '' ? undefined : Number(current.high);
  const validBound = (text: string, number: number | undefined) => number === undefined || /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) && Number.isFinite(number) && number >= minimum && number <= maximum && (!integer || Number.isSafeInteger(number));
  const ordered = left === undefined || right === undefined || left <= right;
  const lowInvalid = current.lowInvalid || !validBound(current.low, left) || !ordered, highInvalid = current.highInvalid || !validBound(current.high, right) || !ordered;
  const valid = !lowInvalid && !highInvalid;
  const description = `${id}-hint${valid ? '' : ` ${id}-error`}`;
  function commit() { if (valid && (left !== low || right !== high)) onChange(left, right); }
  useEffect(() => {
    if (!valid || left === low && right === high) return;
    const timer = setTimeout(() => onChange(left, right), 350);
    return () => clearTimeout(timer);
  }, [valid, left, right, low, high, onChange]);
  return <fieldset className={`range-filter${compact ? ' filter-control-compact' : ''}`}><legend>{compact && label === 'Outlier Score' ? 'Outlier score' : label}{!compact && unit && ` (${unit})`}</legend><div><label className="filter-input-label"><span className={compact ? 'sr-only' : undefined}>Min</span><input data-filter-active={current.low !== ''} aria-label={`Minimum ${label}`} aria-describedby={description} placeholder={placeholders[0]} type="number" min={minimum} max={maximum} step={integer ? '1' : '0.1'} value={current.low} aria-invalid={lowInvalid} onChange={event => setDraft({ ...current, low: event.target.value, lowInvalid: event.target.validity.badInput })} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}/></label>{!compact && <span aria-hidden="true">–</span>}<label className="filter-input-label"><span className={compact ? 'sr-only' : undefined}>Max</span><input data-filter-active={current.high !== ''} aria-label={`Maximum ${label}`} aria-describedby={description} placeholder={placeholders[1]} type="number" min={minimum} max={maximum} step={integer ? '1' : '0.1'} value={current.high} aria-invalid={highInvalid} onChange={event => setDraft({ ...current, high: event.target.value, highInvalid: event.target.validity.badInput })} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}/></label></div><small className={`filter-range-hint${compact ? ' sr-only' : ''}`} id={`${id}-hint`}>Leave either blank for no limit.{compact && unit && ` Values in ${unit}.`}</small>{!valid && <small id={`${id}-error`} className="inline-error" role="status">Use an ordered {minimum.toLocaleString()}–{maximum.toLocaleString()}{unit} range.</small>}</fieldset>;
}

export function KeywordFilter({ value, onChange, compact = false, carousel = false }: { value: string; onChange: (value: string) => void; compact?: boolean; carousel?: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState<{ key: string; text: string } | null>(null);
  const text = draft?.key === value ? draft.text : value;
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => onChange(text.trim()), 350);
    return () => clearTimeout(timer);
  }, [text, value, onChange]);
  return <label className={`field keyword-filter${compact ? ' filter-control-compact' : ''}`} title={carousel ? 'Searches stored carousel captions and usernames.' : 'Searches stored caption/title previews (up to 500 characters).'}>Keywords<div className="search-field" data-filter-active={text.trim() !== ''}>{!compact && <Search size={15}/>}<input type="search" aria-label="Keywords" aria-describedby={`${id}-hint`} placeholder={carousel ? 'Search captions and usernames' : compact ? 'Search captions and titles' : 'e.g. AI tutorial'} maxLength={200} value={text} onChange={event => setDraft({ key: value, text: event.target.value })}/></div><small id={`${id}-hint`} className={`helper-copy${compact ? ' sr-only' : ''}`}>{carousel ? 'Matches carousel captions and usernames.' : 'Matches caption/title previews.'}</small></label>;
}

export function PeriodFilter({ value, onChange, compact = false }: { value: ReelQuery; onChange: (patch: Partial<ReelQuery>) => void; compact?: boolean }) {
  const id = useId();
  const amount = value.posted_amount, selectedUnit = value.posted_unit ?? '';
  const key = `${amount}:${selectedUnit}:${value.from ?? ''}:${value.to ?? ''}`;
  type Unit = NonNullable<ReelQuery['posted_unit']> | '';
  type Draft = { key: string; amount: string; unit: Unit; invalid: boolean };
  const [draft, setDraft] = useState<Draft | null>(null);
  const current = useMemo<Draft>(() => draft?.key === key ? draft : { key, amount: amount === undefined ? '' : String(amount), unit: selectedUnit, invalid: false }, [draft, key, amount, selectedUnit]);
  const text = current.amount, unit = current.unit;
  const maximum = unit ? { days: 366, weeks: 52, months: 12 }[unit] : 366;
  const committed = amount !== undefined && value.posted_unit !== undefined;
  const [error, setError] = useState('');
  const description = `${id}-hint${error ? ` ${id}-error` : ''}`;
  const guidance = (text !== '' || unit !== '') && (text === '' || unit === '') ? 'Complete both amount and unit to apply a period.' : value.from || value.to ? 'Custom dates active; edit here to restore rolling time.' : text === '' && unit === '' ? 'All time' : `Last ${text} ${unit}.`;
  function commit(nextUnit: Unit = unit) {
    try {
      if (current.invalid) throw new Error('Use a positive whole number.');
      if (text !== '' && (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1)) throw new Error('Use a positive whole number.');
      if (text === '' || nextUnit === '') {
        setError('');
        if (committed) {
          setDraft({ ...current, key: `undefined::${value.from ?? ''}:${value.to ?? ''}`, unit: nextUnit });
          onChange({ posted_amount: undefined, posted_unit: undefined });
        }
        return;
      }
      const nextAmount = Number(text);
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(nextAmount) || nextAmount < 1) throw new Error('Use a positive whole number.');
      resolveReelPeriod({ ...value, posted_amount: nextAmount, posted_unit: nextUnit, from: undefined, to: undefined });
      setError('');
      if (nextAmount !== amount || nextUnit !== value.posted_unit || value.from || value.to) onChange({ posted_amount: nextAmount, posted_unit: nextUnit, from: undefined, to: undefined });
    } catch (failure) { setError(errorMessage(failure)); }
  }
  useEffect(() => {
    if (current.invalid || text !== '' && (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1)) return;
    const nextAmount = text === '' || unit === '' ? undefined : Number(text);
    if (nextAmount === undefined && (!committed || draft?.key !== key)) return;
    if (nextAmount === amount && (nextAmount === undefined ? value.posted_unit === undefined : unit === value.posted_unit)) return;
    const patch: Partial<ReelQuery> = nextAmount === undefined ? { posted_amount: undefined, posted_unit: undefined } : { posted_amount: nextAmount, posted_unit: unit as NonNullable<ReelQuery['posted_unit']>, from: undefined, to: undefined };
    try { resolveReelPeriod({ ...value, ...patch }); }
    catch { return; }
    const timer = setTimeout(() => {
      if (nextAmount === undefined) setDraft({ ...current, key: `undefined::${value.from ?? ''}:${value.to ?? ''}` });
      onChange(patch);
    }, 350);
    return () => clearTimeout(timer);
  }, [text, amount, unit, current, value, onChange, committed, draft, key]);
  return <div className={`field period-filter${compact ? ' filter-control-compact' : ''}`}><span>{compact ? 'Posted in last' : 'Posted In Last'}</span><div className="period-inputs"><label className="filter-input-label"><span className={compact ? 'sr-only' : undefined}>Amount</span><input data-filter-active={text !== ''} type="number" aria-label="Posted in last amount" aria-describedby={description} aria-invalid={Boolean(error)} placeholder={compact ? 'Any' : 'e.g. 7'} min={1} max={maximum} step="1" value={text} onChange={event => { setError(''); setDraft({ ...current, amount: event.target.value, invalid: event.target.validity.badInput }); }} onBlur={() => commit()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}/></label><label className="filter-input-label"><span className={compact ? 'sr-only' : undefined}>Unit</span><select data-filter-active={unit !== ''} aria-label="Posted in last unit" aria-describedby={description} value={unit} onChange={event => { const nextUnit = event.target.value as Unit; setDraft({ ...current, unit: nextUnit }); commit(nextUnit); }}><option value="">{compact ? 'Unit' : 'Select unit'}</option><option value="days">Days</option><option value="weeks">Weeks</option><option value="months">Months</option></select></label></div><small id={`${id}-hint`} className={`helper-copy${compact ? ' sr-only' : ''}`}>{guidance}</small>{error && <small id={`${id}-error`} className="inline-error" role="status">{error}</small>}</div>;
}

type FilterScope = { savedOnly?: boolean; creatorId?: string };
export type ActiveFilterItem = { id: string; label: string; keys: (keyof ReelQuery)[] };

export function activeFilterItems(query: ReelQuery, { savedOnly = false, creatorId }: FilterScope = {}, creators: CreatorDirectoryEntry[] = []): ActiveFilterItem[] {
  const items: ActiveFilterItem[] = [];
  const add = (id: string, label: string, keys: (keyof ReelQuery)[]) => items.push({ id, label, keys });
  for (const [label, lowKey, highKey, unit] of [['Outlier Score', 'min_outlier', 'max_outlier', 'x'], ['Profile Outlier Score', 'min_profile_outlier', 'max_profile_outlier', 'x'], ['Views', 'min_views', 'max_views', ''], ['Engagement', 'min_engagement', 'max_engagement', '%']] as const) {
    const low = query[lowKey], high = query[highKey];
    if (low === undefined && high === undefined) continue;
    const format = (value: number) => `${value.toLocaleString('en-US')}${unit}`;
    add(label, `${label}: ${low !== undefined && high !== undefined ? `${format(low)}–${format(high)}` : low !== undefined ? `≥ ${format(low)}` : `≤ ${format(high!)}`}`, [lowKey, highKey]);
  }
  if (query.posted_amount !== undefined && query.posted_unit) add('Period', `Last ${query.posted_amount} ${query.posted_unit}`, ['posted_amount', 'posted_unit']);
  if (query.from || query.to) add('Dates', `Dates: ${query.from && query.to ? `${query.from}–${query.to}` : query.from ? `from ${query.from}` : `to ${query.to}`} (IST)`, ['from', 'to']);
  if (query.keywords?.trim() || query.search?.trim()) add('Keywords', `Keywords: ${[query.keywords?.trim(), query.search?.trim()].filter(Boolean).join(' · ')}`, ['keywords', 'search']);
  const chosen = query.creator_ids ?? (query.creator_id ? [query.creator_id] : undefined);
  if (!creatorId && chosen !== undefined) add('Channels', chosen.length ? `Channels: ${chosen.map(id => { const creator = creators.find(item => item.id === id); return creator ? `@${creator.username}` : 'Unavailable channel'; }).join(', ')}` : 'No channels selected', ['creator_id', 'creator_ids']);
  if (query.freshness && query.freshness !== 'all') add('Freshness', `Freshness: ${query.freshness}`, ['freshness']);
  if (query.status) add('Creator status', `Creator status: ${query.status}`, ['status']);
  if (query.saved && !savedOnly) add('Saved Reels', 'Saved Reels only', ['saved']);
  return items;
}

export function removeFilterCriteria(query: ReelQuery, keys: (keyof ReelQuery)[], scope: FilterScope = {}): ReelQuery {
  const next = { ...query };
  for (const key of keys) {
    if (scope.savedOnly && key === 'saved' || scope.creatorId && (key === 'creator_id' || key === 'creator_ids')) continue;
    next[key] = undefined;
  }
  return { ...filterScope(next, scope), page: 1 };
}

export function clearFilterCriteria(query: ReelQuery, scope: FilterScope = {}): ReelQuery {
  return { ...filterScope({ ...defaultReelFilters(), sort: query.sort, limit: query.limit }, scope), page: 1 };
}

export function filterScope(query: ReelQuery, { savedOnly = false, creatorId }: FilterScope = {}): ReelQuery {
  const { platform: _platform, ...criteria } = query;
  void _platform;
  return { ...criteria, ...(savedOnly ? { saved: true } : {}), ...(creatorId ? { creator_id: creatorId } : {}) };
}

export function ReelPagination({ page, limit, total, count, loading, onPage, itemLabel = 'Reels' }: { page: number; limit: number; total: number; count: number; loading: boolean; onPage: (page: number) => void; itemLabel?: 'Reels' | 'carousels' | 'competitors' }) {
  if (!total && page === 1) return null;
  return <div className="pagination"><p>{count ? `Showing ${(page - 1) * limit + 1}–${Math.min((page - 1) * limit + count, total)} of ${total.toLocaleString()} ${itemLabel}` : `No ${itemLabel} on page ${page} · ${total.toLocaleString()} total`}</p><div><button className="button button-secondary" disabled={page <= 1 || loading} onClick={() => onPage(page - 1)}>Previous</button><span>Page {page} of {Math.max(1, Math.ceil(total / limit))}</span><button className="button button-secondary" disabled={page * limit >= total || loading} onClick={() => onPage(page + 1)}>Next</button></div></div>;
}

export function filterLink(query: ReelQuery) { return reelQueryString({ ...query, page: undefined, limit: undefined }); }
