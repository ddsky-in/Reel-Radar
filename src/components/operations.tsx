'use client';

import { useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Clock3, Pause, Play, RefreshCw, Search, ShieldCheck, Wallet } from 'lucide-react';
import type { AppSettings, Bootstrap, Job, JobStatus, TranscriptOverview, TranscriptStatus } from '../lib/types';
import type { CollectionHold, CollectionHolds, CollectionJobRecovery, CollectionSettlementRequest } from '../lib/types';
import { collectionBudgetMetrics, collectionReservationAge } from '../lib/metrics';
import { invalidateResourceFamilies } from '../lib/resource-cache';
import { api, ApiError as ClientApiError, errorMessage } from '../lib/client';
import { formatDateTime, formatNumber, formatUsd } from '../lib/format';
import { Dialog, Empty, ErrorState, Skeleton, Status, SubmitButton, useResource, type Notify } from './ui';

import { ApifyAccountsPanel } from './apify-accounts';

type JobsProps = {
  bootstrap: Bootstrap; notify: Notify; revision: number;
  /** Legacy caller compatibility only. Job activity never starts paid workspace refreshes. */
  refresh?: () => Promise<void>;
};
type ActivityFilter = 'all' | 'queued' | 'running' | 'attention' | 'completed';
const activityFilters: { key: ActivityFilter; label: string }[] = [
  { key: 'all', label: 'All activity' }, { key: 'queued', label: 'Queued' },
  { key: 'running', label: 'Running' }, { key: 'attention', label: 'Needs attention' },
  { key: 'completed', label: 'Completed' },
];
const activityStates: Record<JobStatus, { group: Exclude<ActivityFilter, 'all'>; label: string; description: string }> = {
  pending: { group: 'queued', label: 'Queued fetch', description: 'Waiting for background collection to start.' },
  dispatching: { group: 'running', label: 'Starting fetch', description: 'Provider submission is in progress; acceptance is not yet confirmed.' },
  running: { group: 'running', label: 'Running fetch', description: 'A provider run is in progress. Charges may apply before billing is reconciled.' },
  processing: { group: 'running', label: 'Saving results', description: 'Returned records are being processed.' },
  succeeded: { group: 'completed', label: 'Completed', description: 'Collection finished.' },
  partial: { group: 'attention', label: 'Partial results', description: 'Only part of the requested work completed. Existing snapshots are preserved.' },
  failed: { group: 'attention', label: 'Failed', description: 'Collection failed. Existing snapshots are preserved.' },
  budget_paused: { group: 'attention', label: 'Budget hold', description: 'New paid work is waiting for allowance. A reservation is not a billed charge.' },
  uncertain: { group: 'attention', label: 'Protected hold', description: 'Submission may have been accepted and billed. Review is required before another paid attempt.' },
};
const activityKinds: Record<Job['kind'], string> = {
  daily: 'Daily Reel fetch', weekly: 'Weekly Reel fetch', backfill: 'Initial Reel import',
  profile: 'Profile fetch', manual: 'Manual Reel fetch', retry: 'Retry collection',
  discovery: 'Discovery collection', metrics: 'Metrics refresh', carousel: 'Carousel fetch',
};

export function Jobs({ bootstrap, notify, revision }: JobsProps) {
  const [localRevision, setLocalRevision] = useState(0), [filter, setFilter] = useState<ActivityFilter>('all'), [search, setSearch] = useState(''), [showTranscription, setShowTranscription] = useState(false);
  const resource = useResource<Bootstrap>('/api/bootstrap', revision + localRevision);
  const recent = resource.data?.jobs ?? [];
  const query = search.trim().toLowerCase();
  const jobs = recent.filter(job => (filter === 'all' || activityStates[job.status].group === filter) && (!query || [
    activityKinds[job.kind], job.kind, job.status, activityStates[job.status].label, job.id, job.actor_run_id,
  ].filter(Boolean).join(' ').toLowerCase().includes(query)));
  const settings = resource.data?.settings ?? bootstrap.settings;
  function reload() { setLocalRevision(value => value + 1); notify('Refreshing job activity.'); }
  function clearFilters() { setFilter('all'); setSearch(''); }
  return <div className="jobs-page">
    <div className="page-heading jobs-heading"><div><h1>Job activity</h1><p>Check collection progress without starting a paid run.</p></div><div className="heading-actions"><button type="button" className="button button-secondary" disabled={resource.loading || resource.refreshing} onClick={reload}><RefreshCw size={15} aria-hidden="true"/>Refresh activity</button></div></div>
    {bootstrap.mode === 'demo' ? <p className="jobs-notice" role="status">Synthetic demo activity · not verified Instagram data. No external provider is called.</p> : !settings.scraping_enabled && <p className="jobs-notice" role="status">Live collection is disabled. Queued fetches may need server setup; refreshing activity does not enable collection.</p>}
    <section className="panel jobs-activity" aria-labelledby="recent-activity-heading">
      <div className="jobs-activity-heading"><div><h2 id="recent-activity-heading">Recent collection</h2><p id="jobs-scope">Recent jobs across your workspaces. Counts cover this recent list, not the complete backlog.</p></div><span className="jobs-update-status" role="status">{resource.loading ? 'Loading activity…' : resource.refreshing ? 'Updating activity…' : resource.error ? 'Activity update unavailable' : resource.data ? 'Showing last loaded activity' : 'Activity not loaded'}</span></div>
      <div className="jobs-controls">
        <div className="jobs-filter-chips" role="group" aria-label="Filter recent job activity" aria-describedby="jobs-scope">{activityFilters.map(item => <button type="button" key={item.key} className="jobs-filter-chip" aria-pressed={filter === item.key} disabled={!resource.data} onClick={() => setFilter(item.key)}>{item.label}<span className="jobs-filter-count">{resource.data ? recent.filter(job => item.key === 'all' || activityStates[job.status].group === item.key).length : '—'}</span></button>)}</div>
        <label className="jobs-search"><Search size={16} aria-hidden="true"/><span className="sr-only">Search job activity</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search kind, status or job ID" aria-describedby="jobs-search-hint"/></label>
      </div>
      <p id="jobs-search-hint" className="sr-only">Search recent jobs by kind, status, job ID or provider run ID. Creator names are not included in collection job data.</p>
      {resource.error && resource.data && <p className="jobs-inline-error" role="alert">Couldn’t update activity. Showing the last loaded list. {resource.error} <button type="button" className="text-link" disabled={resource.refreshing} onClick={reload}>Retry</button></p>}
      {resource.loading && !resource.data ? <Skeleton/> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={reload}/> : resource.data && <>
        <div className="jobs-result-count" role="status">Showing {jobs.length} of {recent.length} recent jobs{(filter !== 'all' || query) && <button type="button" className="text-link" onClick={clearFilters}>Clear filters</button>}</div>
        {!jobs.length ? <Empty title={recent.length ? 'No matching jobs' : 'No recent collection jobs'} description={recent.length ? 'Try another status or search term.' : 'Collection activity will appear here when work is queued. Refreshing this page does not start a run.'}/> : <ul className="jobs-activity-list" aria-label="Recent collection jobs">{jobs.map(job => {
          const state = job.operational_disposition === 'risk_released' && job.status === 'uncertain' ? { group: 'attention' as const, label: 'Released · liability unknown', description: 'Protection was released by a user decision. Billing remains unknown; late run recovery is retained.' } : activityStates[job.status];
          const time = job.completed_at ? { label: 'Completed', value: job.completed_at } : job.started_at ? { label: 'Started', value: job.started_at } : { label: 'Scheduled', value: job.scheduled_for };
          const billingKnown = job.actual_cost_usd !== null && Number.isFinite(job.actual_cost_usd);
          const boundedMetrics = job.kind === 'metrics' && Number.isSafeInteger(job.metrics_tracked_count) && (job.metrics_tracked_count ?? 0) >= 1;
          const boundedDiscovery = job.kind === 'discovery' && job.discovery_bounded === true && job.results_limit === 50;
          return <li key={job.id} className={`jobs-activity-row jobs-activity-row--${state.group}`}>
            <div className="jobs-row-main"><div className="jobs-row-identity"><h3>{activityKinds[job.kind]}</h3><p>{formatNumber(job.requested_profiles_count)} {job.requested_profiles_count === 1 ? 'profile' : 'profiles'}{job.apify_account_slot ? ` · Apify account ${job.apify_account_slot}` : ''}</p></div><span className={`jobs-state jobs-state--${state.group}`}>{state.label}</span></div>
            <div className="jobs-row-meta"><span>{time.label} <time dateTime={time.value}>{formatDateTime(time.value)}</time></span>{!['pending', 'budget_paused'].includes(job.status) && <span>{formatNumber(job.returned_records_count)} records returned</span>}<span className={`jobs-billing${billingKnown && bootstrap.mode !== 'demo' ? ' jobs-billing--known' : ''}`}>{bootstrap.mode === 'demo' ? 'Synthetic billing' : billingKnown ? `${formatUsd(job.actual_cost_usd)} billed` : 'Cost unknown'}</span></div>
            {job.error_message && <p className="jobs-error-preview">{job.error_message}</p>}
            {(state.group === 'attention' || state.group === 'queued') && <p className="jobs-state-note">{state.description}</p>}
            <details className="jobs-row-details"><summary aria-label={`Details for ${activityKinds[job.kind]} job ${job.id}`}>Details</summary><div className="jobs-details-body">
              <p>{state.description}</p>
              {job.kind === 'discovery' && <p>{boundedDiscovery ? 'Discovery scans a recent window capped at 50 Reels per profile. This is a maximum scan, not 50 guaranteed returns or 50 new Reels; older Reels outside that window may be missed.' : 'Historical discovery scan: this job retains its original request limit; it was not recorded as a bounded 50-Reel discovery scan.'}</p>}
              {job.kind === 'metrics' && <p>{boundedMetrics ? 'Tracked Reel count is frozen for this job. Only existing tracked Reels are updated; extra/new Reels are not imported.' : 'Historical broad scan: no frozen tracked Reel count was recorded for this job.'}</p>}
              {boundedMetrics && (job.metrics_tracked_count ?? 0) > 9_950 && <p>The 10,000-Reel request cap makes the effective extra Reel buffer smaller than 50.</p>}
              <dl><div><dt>Job ID</dt><dd>{job.id}</dd></div><div><dt>Attempt count</dt><dd>{job.attempt_count}</dd></div><div><dt>Scheduled</dt><dd>{formatDateTime(job.scheduled_for)}</dd></div><div><dt>Started</dt><dd>{job.started_at ? formatDateTime(job.started_at) : 'Not started'}</dd></div><div><dt>Completed</dt><dd>{job.completed_at ? formatDateTime(job.completed_at) : 'Not completed'}</dd></div><div><dt>Records returned</dt><dd>{formatNumber(job.returned_records_count)}</dd></div>{boundedMetrics && <><div><dt>Tracked Reels</dt><dd>{formatNumber(job.metrics_tracked_count)}</dd></div><div><dt>Extra Reel buffer</dt><dd>50</dd></div></>}<div><dt>{boundedDiscovery ? 'Maximum discovery scan / profile' : boundedMetrics ? 'Maximum requested / profile' : 'Requested posts / profile'}</dt><dd>{formatNumber(job.results_limit)}{job.kind === 'carousel' ? ' photo posts' : ''}</dd></div><div><dt>Actual billed</dt><dd>{bootstrap.mode === 'demo' ? 'Not applicable (synthetic demo)' : billingKnown ? formatUsd(job.actual_cost_usd) : 'Unknown'}</dd></div>{job.actor_run_id && <div><dt>Provider run ID</dt><dd>{job.actor_run_id}</dd></div>}</dl>
              {job.error_message && <div className="jobs-full-error"><strong>Status details</strong><p>{job.error_message}</p></div>}
            </div></details>
          </li>;
        })}</ul>}
      </>}
      <details className="jobs-data-note"><summary>About this activity</summary><p>Times use Asia/Kolkata (IST). Requested posts are limits, not guaranteed returns; returned records are not a completion percentage. Carousel fetches examine photo posts and exclude single images. Actual provider costs stay unknown until authoritative billing is reconciled. Estimates and reservations are not billed charges. Failed jobs preserve existing snapshots. Collection job data does not include creator names.</p></details>
    </section>
    <CollectionHoldsPanel bootstrap={resource.data ?? bootstrap} notify={notify} revision={revision + localRevision}/>
    <details className="jobs-transcription-toggle" onToggle={event => setShowTranscription(event.currentTarget.open)}>
      <summary>On-demand transcription activity</summary>
      <p className="jobs-transcription-hint">Only explicitly requested Reels are transcribed. Expand to load transcription status, holds and recent requests. Spending and pause controls remain available in <a className="text-link" href="/settings#automation">Settings</a>.</p>
      {showTranscription && <TranscriptionSection bootstrap={bootstrap} notify={notify} revision={revision + localRevision} showJobs/>}
    </details>
  </div>;
}

export function Settings({ bootstrap, notify }: { bootstrap: Bootstrap; notify: Notify }) {
  const [draft, setDraft] = useState<CollectionDraft>({}), [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ previous: Bootstrap['settings']; value: Bootstrap['settings'] } | null>(null);
  const [section, setSection] = useState<'preferences' | 'billing'>('preferences');
  const [billingVisited, setBillingVisited] = useState(false);
  const settings = saved?.previous === bootstrap.settings ? saved.value : bootstrap.settings;
  const settingNumber = (field: CollectionNumberField) => field === 'collection_job_cap_usd' ? settings[field] ?? .1 : settings[field];
  const fieldValue = (field: CollectionNumberField) => draft[field] ?? String(settingNumber(field));
  const setField = (field: CollectionNumberField, value: string) => setDraft(fields => ({ ...fields, [field]: value }));
  const paused = draft.paused ?? settings.paused;
  const dirty = collectionNumberFields.some(field => numberDraftChanged(draft[field], settingNumber(field))) || paused !== settings.paused;
  const budget = collectionBudgetMetrics(settings, bootstrap.usage, bootstrap.collection_capacity);
  function showBilling() { setBillingVisited(true); setSection('billing'); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!dirty || !(event.currentTarget as HTMLFormElement).reportValidity()) return;
    const input: Partial<AppSettings> = {};
    for (const field of collectionNumberFields) if (numberDraftChanged(draft[field], settingNumber(field))) input[field] = Number(draft[field]);
    if (paused !== settings.paused) input.paused = paused;
    setBusy(true);
    try { const value = await api<Bootstrap['settings']>('/api/settings', { method: 'PATCH', body: JSON.stringify(input) }); setSaved({ previous: bootstrap.settings, value }); setDraft({}); notify('Collection preferences saved.'); }
    catch (error) { notify(errorMessage(error), 'error'); } finally { setBusy(false); }
  }
  return <div className="settings-page">
    <div className="page-heading operations-page-heading"><div><h1>Settings</h1><p className="operations-intro">Manage collection, transcription and spending.</p></div></div>
    <nav className="settings-section-nav" aria-label="Settings sections">
      <button type="button" aria-pressed={section === 'preferences'} onClick={() => setSection('preferences')}>Preferences</button>
      <button type="button" aria-pressed={section === 'billing'} onClick={showBilling}>Billing & accounts</button>
    </nav>
    <div className="settings-content-section" hidden={section !== 'preferences'}>
    <div className="settings-workspace-grid">
      <form className="panel settings-form" onSubmit={save} aria-label="Collection preferences" aria-busy={busy}>
        <div className="settings-section-heading" id="spending"><span className="settings-section-icon"><Wallet size={19} aria-hidden="true"/></span><div><h2>Collection</h2><p>Profiles, Reels and video-source recovery.</p></div></div>
        <fieldset className="settings-fields personal-settings-fields settings-budget-field" disabled={busy}>
          <legend className="sr-only">Collection budget</legend>
          <label className="field">Monthly collection budget (USD)<input aria-describedby="collection-budget-hint" type="number" min="0" max="10000" step="0.000001" required value={fieldValue('monthly_budget_usd')} onChange={event => setField('monthly_budget_usd', event.target.value)}/><span className="field-hint" id="collection-budget-hint">Includes reserved work. Set 0 to stop new paid collection.</span></label>
          <label className="field">Per-job collection cap (USD)<input aria-describedby="collection-job-cap-hint" type="number" min="0" max="10000" step="0.000001" required value={fieldValue('collection_job_cap_usd')} onChange={event => setField('collection_job_cap_usd', event.target.value)}/><span className="field-hint" id="collection-job-cap-hint">Default $0.10 per new job. Set 0 to stop new jobs. Saving never dispatches.</span></label>
        </fieldset>
        {(bootstrap.mode === 'demo' || !settings.scraping_enabled) && <p className="controls-unavailable" role="status">{bootstrap.mode === 'demo' ? 'Synthetic demo · no live collection.' : 'Live collection is disabled. Changing a budget does not enable it.'}</p>}
        <label className="pause-setting personal-pause-setting"><span className="pause-icon"><Pause size={18} aria-hidden="true"/></span><span><strong>Pause automatic collection</strong><small id="collection-pause-hint">Pauses scheduled updates when saved. Manual refreshes remain available.</small></span><input aria-label="Pause automatic collection" aria-describedby="collection-pause-hint" disabled={busy} type="checkbox" className="switch-input" checked={paused} onChange={event => setDraft(fields => ({ ...fields, paused: event.target.checked }))}/></label>
        <details className="settings-collection-options" id="collection"><summary>Collection options</summary>
        <fieldset className="settings-fields personal-settings-fields" disabled={busy}>
          <legend className="sr-only">Collection batch sizes and capacity</legend>
          <label className="field settings-capacity-field">Profile capacity<input aria-label="Tracked profile capacity" aria-describedby="collection-capacity-hint" type="number" min="1" max="1000" step="1" required value={fieldValue('capacity')} onChange={event => setField('capacity', event.target.value)}/><span className="field-hint" id="collection-capacity-hint">Shared profiles count once across your workspaces.</span></label>
          <label className="field">Daily Reels per creator<input aria-describedby="collection-daily-hint" type="number" min="10" max="30" step="1" required value={fieldValue('daily_limit')} onChange={event => setField('daily_limit', event.target.value)}/><span className="field-hint" id="collection-daily-hint">Requested at 05:00 IST, when scheduled.</span></label>
          <label className="field">Weekly Reels per creator<input aria-describedby="collection-weekly-hint" type="number" min="10" max="30" step="1" required value={fieldValue('weekly_limit')} onChange={event => setField('weekly_limit', event.target.value)}/><span className="field-hint" id="collection-weekly-hint">A wider refresh. Changing this does not start a run.</span></label>
        </fieldset>
        <p className="field-hint">{settings.initial_backfill_enabled ? 'New profiles start with up to 100 Reels.' : 'Initial collection for new profiles is awaiting activation.'}</p>
        </details>
        <div className="settings-submit"><span className={dirty ? 'settings-dirty' : ''} role="status">{dirty ? 'Unsaved collection changes' : saved ? 'Collection preferences saved' : 'All changes saved'}</span><SubmitButton aria-label="Save changes to collection preferences" busy={busy} disabled={!dirty}>Save changes</SubmitButton></div>
      </form>
      <TranscriptionSection bootstrap={bootstrap} notify={notify}/>
    </div>
    <div className="settings-billing-shortcut"><div><strong>Usage & billing</strong><p>{budget.paid_starts_gated ? 'New paid collection is gated. ' : ''}{bootstrap.usage.unreconciled_jobs > 0 ? `${bootstrap.usage.unreconciled_jobs} collection cost(s) still unknown. ` : ''}Account usage, reserved funds and billing history.</p></div><button type="button" className="button button-secondary" onClick={showBilling}>View billing →</button></div>
    </div>
    <div className="settings-content-section settings-billing-content" hidden={section !== 'billing'}>
      {billingVisited && <>
        <section className="panel settings-billing-overview" aria-label="Collection spending overview">
          <div className="settings-section-heading"><div><h2>Collection spending</h2><p>Reported charges and reserved work are shown separately.</p></div><a href="/jobs" className="text-link">View job activity →</a></div>
          <dl className="settings-billing-metrics"><div><dt>Reconciled this month</dt><dd>{bootstrap.mode === 'demo' ? 'Synthetic only' : collectionAmount(budget.subtotal)}</dd></div><div><dt>Reserved · not billed</dt><dd>{collectionAmount(budget.reserved)}</dd></div><div><dt>Monthly app budget</dt><dd>{collectionAmount(settings.monthly_budget_usd)}</dd></div></dl>
          {budget.paid_starts_gated && <p className="settings-billing-notice" role="status">New paid collection is gated or awaiting verified setup.</p>}
          {(bootstrap.usage.unreconciled_jobs > 0 || (budget.exposure ?? 0) > 0) && <p className="settings-billing-notice">{bootstrap.usage.unreconciled_jobs} collection cost(s) remain unreconciled. Historical released amounts are not confirmed charges. <a href="/jobs" className="text-link">Review in job activity →</a></p>}
          <details className="settings-audit-details"><summary>Cost protection & historical liability</summary><CollectionSpending bootstrap={bootstrap} settings={settings}/></details>
        </section>
        {bootstrap.mode !== 'demo' && <ApifyAccountsPanel notify={notify}/>}
      </>}
    </div>
  </div>;
}

function collectionAmount(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'Unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
}
const phaseLabels: Record<CollectionHold['dispatch_phase'], string> = {
  legacy: 'Historical / legacy', prepared: 'Prepared, not authorized', submission_authorized: 'Submission authorized',
  request_unknown: 'Request outcome unknown', accepted_save_pending: 'Accepted, attachment pending', attached: 'Run attached', cancelled_before_submit: 'Cancelled before submission',
};

export function CollectionSpending({ bootstrap, settings = bootstrap.settings, holds }: { bootstrap: Bootstrap; settings?: AppSettings; holds?: CollectionHolds }) {
  const usage = holds ? { ...bootstrap.usage, ...holds.usage } : bootstrap.usage;
  const capacity = holds?.capacity ?? bootstrap.collection_capacity;
  const budget = collectionBudgetMetrics(settings, usage, capacity);
  return <section className="panel collection-spending" aria-label="Collection billing and capacity">
    <h2>Collection billing and capacity</h2>
    <dl className="collection-summary-grid">
      <div><dt>Reconciled monthly subtotal</dt><dd>{bootstrap.mode === 'demo' ? 'Synthetic only' : collectionAmount(budget.subtotal)}</dd></div>
      <div><dt>Reserved · not confirmed billed</dt><dd>{collectionAmount(budget.reserved)}</dd></div>
      <div><dt>Unreconciled costs</dt><dd>{bootstrap.mode === 'demo' ? 'No provider costs' : `${usage.unreconciled_jobs} job(s) · cost unknown`}</dd></div>
      <div><dt>Risk-released exposure · still unknown</dt><dd>{collectionAmount(budget.exposure)} <small>original held amount, not a bill or liability ceiling</small></dd></div>
      <div><dt>Occupied global slots</dt><dd>{capacity ? `${capacity.occupied_slots} / ${capacity.max_active}` : 'Unverified'}</dd></div>
      <div><dt>Uncertain occupied slots</dt><dd>{capacity ? capacity.uncertain_slots : 'Unverified'}</dd></div>
    </dl>
    <p className="collection-safety-note" role="status">{budget.paid_starts_gated ? 'New paid starts are gated or awaiting verified configuration.' : 'New paid starts remain subject to transactional budget, per-job cap, and account checks.'} {capacity?.paid_starts_gated ? 'The administrator-controlled paid-start gate is enabled.' : ''}</p>
    <p className="helper-copy">Known billing excludes unreconciled charges. Reservations are not confirmed bills. A risk release does not prove no charge, guarantee budget remaining, or stop late run recovery. Saving limits never starts collection.</p>
  </section>;
}

export function CollectionHoldsPanel({ bootstrap, notify, revision = 0 }: { bootstrap: Bootstrap; notify: Notify; revision?: number }) {
  const [page, setPage] = useState(1), [localRevision, setLocalRevision] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const resource = useResource<CollectionHolds>(`/api/jobs/holds?page=${page}&limit=25`, revision + localRevision);
  const data = resource.data;
  function reload() { setLocalRevision(value => value + 1); }
  return <section className="panel collection-holds" aria-labelledby="collection-holds-heading">
    <div className="panel-heading"><div><h2 id="collection-holds-heading">Protected holds and released liability</h2><p>All owner-authorized unresolved holds, independently paged from the latest 50 jobs. Released unknown charges stay visible.</p></div><button type="button" className="button button-secondary" disabled={resource.loading || resource.refreshing} onClick={reload}>Refresh holds</button></div>
    {data && <CollectionSpending bootstrap={bootstrap} holds={data}/>}
    {resource.error && <ErrorState message={resource.error} retry={reload}/>}
    {resource.loading && !data ? <Skeleton/> : data && <>
      {data.items.length ? <ul className="collection-hold-list" aria-label="Unresolved collection holds">{data.items.map(hold => <li key={hold.id}>
        <div><strong>{activityKinds[hold.kind]}</strong><span className="block-muted">{hold.creators.map(creator => `@${creator.username}`).join(', ') || 'No affected profiles currently linked'}{hold.account_slot ? ` · Account ${hold.account_slot}` : ''}</span><span className="block-muted">{phaseLabels[hold.dispatch_phase]} · {hold.recovery_reason ?? 'Cost awaiting authoritative reconciliation'}</span></div>
        <div><strong>{hold.operational_disposition === 'risk_released' ? 'Released · liability unknown' : 'Protected hold'}</strong><span className="block-muted">{collectionAmount(hold.reserved_usd)} reserved · {hold.recovery_attempts} recovery attempts</span></div>
        <button type="button" className="button button-secondary" aria-label={`Review recovery for job ${hold.id}`} onClick={() => setSelected(hold.id)}>Review hold</button>
      </li>)}</ul> : <p className="helper-copy">{bootstrap.mode === 'demo' ? 'Synthetic demo has no real provider holds or liability.' : 'No unresolved collection holds on this page.'}</p>}
      <div className="collection-hold-paging"><span role="status">Page {data.page} · {data.total} unresolved hold(s)</span><button type="button" className="button button-secondary" disabled={page <= 1 || resource.loading || resource.refreshing} onClick={() => setPage(value => value - 1)}>Previous holds</button><button type="button" className="button button-secondary" disabled={data.page * data.limit >= data.total || resource.loading || resource.refreshing} onClick={() => setPage(value => value + 1)}>Next holds</button></div>
    </>}
    {selected && <CollectionRecoveryDialog key={selected} jobId={selected} demo={bootstrap.mode === 'demo'} gated={data?.capacity.paid_starts_gated === true} notify={notify} close={() => setSelected(null)}/>}
  </section>;
}

export function CollectionRecoveryDialog({ jobId, demo, gated, notify, close }: { jobId: string; demo: boolean; gated: boolean; notify: Notify; close: () => void }) {
  const resource = useResource<CollectionJobRecovery>(`/api/jobs/${jobId}/recovery`);
  const [readback, setReadback] = useState<{ previous: CollectionJobRecovery | null; value: CollectionJobRecovery } | null>(null), [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState(''), [acknowledge, setAcknowledge] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [needsReadback, setNeedsReadback] = useState(false);
  const pending = useRef(false), key = useRef<string | null>(null);
  const recovery = readback && readback.previous === resource.data ? readback.value : resource.data;
  const released = recovery?.operational_disposition === 'risk_released';
  async function readStored() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      setReadback({ previous: resource.data, value: await api<CollectionJobRecovery>(`/api/jobs/${jobId}/recovery`) });
      setNeedsReadback(false); setConfirm(false); setAcknowledge(false); key.current = null;
      setError('Stored state read back. No settlement was retried. Review the current outcome before any new decision.');
      invalidateResourceFamilies(['jobs', 'settings', 'creators']);
    } catch (error) { setError(`Readback unavailable. ${errorMessage(error)} Do not repeat settlement until stored state can be read.`); }
    finally { pending.current = false; setBusy(false); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current || needsReadback || demo || !gated || !recovery || released || !acknowledge || reason.trim().length < 10) return;
    pending.current = true; setBusy(true); setError('');
    key.current ??= crypto.randomUUID();
    const body: CollectionSettlementRequest = { outcome: 'risk_release', reason: reason.trim(), idempotency_key: key.current, expected_version: recovery.expected_version, acknowledge_unknown: true };
    try {
      const result = await api<CollectionJobRecovery>(`/api/jobs/${jobId}/settlement`, { method: 'POST', body: JSON.stringify(body) });
      setReadback({ previous: resource.data, value: result }); setConfirm(false); setAcknowledge(false);
      notify('Stored risk release confirmed. Charges remain unknown; late run recovery is retained.');
    } catch (error) {
      setNeedsReadback(true); setConfirm(false);
      setError(error instanceof ClientApiError && error.code === 'REQUEST_TIMEOUT' ? 'Settlement timed out and may have committed. Read back stored state before any new decision. No retry or hold clearing was performed.' : `${errorMessage(error)} Read back stored state before any new decision.`);
    } finally { pending.current = false; setBusy(false); }
  }
  return <Dialog title="Collection hold recovery" subtitle="Review stored evidence without starting a run." className="collection-recovery-dialog" onClose={() => { if (!pending.current) close(); }}>
    <div aria-busy={busy}>
      {resource.loading && !recovery ? <Skeleton/> : recovery && <>
        <dl className="collection-summary-grid"><div><dt>Job ID</dt><dd>{recovery.id}</dd></div><div><dt>Submission phase</dt><dd>{phaseLabels[recovery.dispatch_phase]}</dd></div><div><dt>Disposition</dt><dd>{released ? 'Risk released · liability unknown' : 'Protected'}</dd></div><div><dt>Reserved · not billed</dt><dd>{collectionAmount(recovery.reserved_usd)}</dd></div><div><dt>Claimed per-job cap</dt><dd>{collectionAmount(recovery.claimed_cap_usd)}</dd></div><div><dt>Actual billed</dt><dd>{collectionAmount(recovery.actual_cost_usd)}</dd></div><div><dt>Reservation started</dt><dd>{formatDateTime(recovery.reservation_started_at)}</dd></div><div><dt>Reservation age</dt><dd>{collectionReservationAge(recovery) === null ? 'Not recorded' : `${collectionReservationAge(recovery)} minutes`}</dd></div><div><dt>Uncertain since</dt><dd>{recovery.uncertain_since ? formatDateTime(recovery.uncertain_since) : 'Not recorded for this historical hold'}</dd></div><div><dt>Recovery attempts</dt><dd>{recovery.recovery_attempts}</dd></div></dl>
        <p className="helper-copy">Affected profiles: {recovery.creators.map(creator => `@${creator.username}`).join(', ') || 'None currently linked'}. {recovery.recovery_reason}</p>
        <p className="collection-safety-note">{released ? 'The reservation was released by a user risk decision, not by proof of no charge. Liability remains unknown and late accepted-run attachment and billing recovery continue.' : 'A risk release removes operational protection only. The provider may already have accepted and billed this request. It does not stop the provider or certify a zero charge.'}</p>
        <p className="helper-copy">Verified no-start settlement is unavailable here. Only independently stored server evidence can certify no submission; a user declaration cannot.</p>
        {recovery.audit.length > 0 && <details className="collection-audit"><summary>Settlement history</summary><ul>{recovery.audit.map((entry, index) => <li key={`${entry.created_at}-${index}`}><strong>{entry.outcome === 'risk_release' ? 'User risk release' : 'Server-certified no start'}</strong> · {formatDateTime(entry.created_at)} · {collectionAmount(entry.released_usd)} released<p>{entry.reason}</p></li>)}</ul></details>}
        {!released && !demo && !gated && <p className="collection-safety-note">Risk release requires the administrator-controlled global paid-start gate to be enabled. No resume control is available here.</p>}
        {confirm && !released && <form onSubmit={submit} aria-label="Confirm collection risk release">
          <h3>Accept unknown billing liability?</h3>
          <p className="helper-copy">You are releasing {collectionAmount(recovery.reserved_usd)} of reservation protection. The eventual charge may differ; available budget is not guaranteed. This does not retry collection.</p>
          <label className="field">Decision reason<textarea required minLength={10} maxLength={1000} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} rows={3}/></label>
          <label className="collection-risk-ack"><input type="checkbox" required checked={acknowledge} disabled={busy} onChange={event => setAcknowledge(event.target.checked)}/><span>I accept that this request may have started and may still be billed. Releasing protection does not prove no charge or guarantee budget remaining.</span></label>
          <div className="dialog-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setConfirm(false)}>Keep protected</button><SubmitButton busy={busy} disabled={!gated || !acknowledge || reason.trim().length < 10 || needsReadback} className="button button-danger">Confirm risk release</SubmitButton></div>
        </form>}
        {!confirm && !released && <div className="dialog-actions"><button type="button" className="button button-secondary" disabled={busy || needsReadback || demo || !gated} onClick={() => setConfirm(true)}>Review risk release decision</button></div>}
      </>}
      {(error || resource.error) && <p className="inline-error" role="alert">{error || resource.error}</p>}
      <div className="dialog-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={readStored}>Read back stored state</button><button type="button" className="button button-secondary" disabled={busy} onClick={close}>Close review</button></div>
    </div>
  </Dialog>;
}

const collectionNumberFields = ['monthly_budget_usd', 'collection_job_cap_usd', 'capacity', 'daily_limit', 'weekly_limit'] as const;
type CollectionNumberField = typeof collectionNumberFields[number];
type CollectionDraft = Partial<Record<CollectionNumberField, string>> & { paused?: boolean };
type TranscriptDraft = Partial<Record<'monthly_budget_usd', string>>;
function numberDraftChanged(value: string | undefined, previous: number) { return value !== undefined && (value.trim() === '' || Number(value) !== previous); }

function TranscriptionSection({ bootstrap, notify, revision = 0, showJobs = false }: { bootstrap: Bootstrap; notify: Notify; revision?: number; showJobs?: boolean }) {
  const [localRevision, setLocalRevision] = useState(0), [busy, setBusy] = useState(false), [draft, setDraft] = useState<TranscriptDraft>({}), [filter, setFilter] = useState('all');
  const [saved, setSaved] = useState<{ previous: TranscriptOverview; value: TranscriptOverview } | null>(null);
  const resource = useResource<TranscriptOverview>('/api/transcription', revision + localRevision);
  const overview = saved?.previous === resource.data ? saved.value : resource.data;
  const dirty = !!overview && numberDraftChanged(draft.monthly_budget_usd, overview.monthly_budget_usd);
  const editable = overview?.preferences_editable === true && bootstrap.mode !== 'demo';
  async function togglePause() {
    if (!overview || !overview.enabled) return;
    setBusy(true);
    try {
      const result = await api<TranscriptOverview>('/api/transcription', { method: 'PATCH', body: JSON.stringify({ paused: !overview.paused }) });
      if (resource.data) setSaved({ previous: resource.data, value: result });
      notify(result.paused ? 'Transcript requests paused.' : 'Transcript requests resumed. Only Reels requested with Get transcript can be processed.');
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  }
  async function saveSpending(event: React.FormEvent) {
    event.preventDefault();
    if (!overview || !editable || !dirty || !(event.currentTarget as HTMLFormElement).reportValidity()) return;
    const input: { monthly_budget_usd?: number } = {};
    if (numberDraftChanged(draft.monthly_budget_usd, overview.monthly_budget_usd)) input.monthly_budget_usd = Number(draft.monthly_budget_usd);
    setBusy(true);
    try {
      const value = await api<TranscriptOverview>('/api/transcription', { method: 'PATCH', body: JSON.stringify(input) });
      if (resource.data) setSaved({ previous: resource.data, value });
      setDraft({}); notify('Transcription spending preferences saved.');
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  }
  const jobs = overview?.jobs.filter(job => filter === 'all' || filter === 'working' && ['queued', 'submitting', 'processing', 'awaiting_media', 'budget_paused'].includes(job.status) || filter === 'ready' && job.status === 'ready' || filter === 'attention' && ['media_unavailable', 'failed', 'uncertain'].includes(job.status)) ?? [];
  return <section className={`panel transcript-operations personal-automation${showJobs ? '' : ' settings-automation'}`} id={showJobs ? 'transcription-activity' : 'automation'} aria-label="On-demand transcription">
    {showJobs ? <div className="panel-heading automation-heading"><span className="automation-heading-icon"><Activity size={21} aria-hidden="true"/></span><div><span className="operations-eyebrow">Transcripts</span><h2>On-demand transcription</h2><p>Transcription starts only when you select Get transcript on a Reel.</p></div><button type="button" className="button button-secondary" aria-label="Refresh transcription status" disabled={resource.loading || resource.refreshing || busy} onClick={() => setLocalRevision(value => value + 1)}><RefreshCw size={14} aria-hidden="true"/>Refresh status</button></div> : <div className="settings-section-heading"><span className="settings-section-icon"><Activity size={19} aria-hidden="true"/></span><div><h2>Transcription</h2><p>Select Get transcript on a Reel to transcribe its audio.</p></div></div>}
    {resource.error && <ErrorState message={resource.error} retry={() => setLocalRevision(value => value + 1)}/>}
    {resource.loading && !overview ? <p className="helper-copy" role="status" aria-busy="true">Loading transcription activity…</p> : overview && <>
      {showJobs && <TranscriptionUsage overview={overview} demo={bootstrap.mode === 'demo'}/>}
      <div className="automation-preferences">
        {!showJobs && <form className="transcript-spending-form" onSubmit={saveSpending} aria-label="Transcription spending preferences">
          {!editable && <p className="controls-unavailable" role="status">{bootstrap.mode === 'demo' ? 'Spending controls are disabled in this synthetic demo.' : 'Transcription spending controls are currently unavailable. Your existing allowance still applies.'}</p>}
          <fieldset className="settings-fields personal-settings-fields settings-budget-field" disabled={busy || !editable}>
            <legend className="sr-only">Transcription spending controls</legend>
            <label className="field">Monthly transcription budget (USD)<input aria-describedby="transcription-budget-hint" type="number" min="0" max="10000" step="0.000001" required value={draft.monthly_budget_usd ?? String(overview.monthly_budget_usd)} onChange={event => setDraft(fields => ({ ...fields, monthly_budget_usd: event.target.value }))}/><span className="field-hint" id="transcription-budget-hint">Includes reserved work. Set 0 to stop new paid transcription.</span></label>
          </fieldset>
          <div className="settings-submit"><span className={dirty ? 'settings-dirty' : ''} role="status">{dirty ? 'Unsaved transcription changes' : saved ? 'Transcription preferences saved' : 'All changes saved'}</span><SubmitButton aria-label="Save changes to transcription preferences" busy={busy} disabled={!editable || !dirty}>Save changes</SubmitButton></div>
        </form>}
        {!showJobs && <TranscriptionUsage overview={overview} demo={bootstrap.mode === 'demo'} compact/>}
        <div className="pause-setting transcript-pause personal-pause-setting"><span className="pause-icon">{overview.paused ? <Play size={18} aria-hidden="true"/> : <Pause size={18} aria-hidden="true"/>}</span><span><strong>{overview.paused ? 'Transcript requests paused' : 'On-demand transcription'}</strong><small>Only explicitly requested Reels are processed. Opening a Reel or refreshing data does not start transcription.</small></span><SubmitButton type="button" busy={busy} disabled={bootstrap.mode === 'demo' || !overview.enabled} onClick={togglePause}>{overview.paused ? 'Resume requests' : 'Pause requests'}</SubmitButton></div>
      </div>
      {showJobs && <div className="transcript-jobs"><div className="manager-toolbar"><div><h3>Transcription activity</h3><p className="field-hint">Recent jobs · failed media is preserved for review.</p></div><select aria-label="Filter transcription activity" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All activity</option><option value="working">Waiting / in progress</option><option value="ready">Ready transcripts</option><option value="attention">Needs attention</option></select></div>{!jobs.length ? <Empty title="No matching transcription jobs" description="Select Get transcript on a Reel to add a request. Imported videos are not transcribed automatically."/> : <div className="table-scroll"><table className="data-table jobs-table transcript-activity-table"><thead><tr><th>Reel / creator</th><th>Status</th><th>Attempts</th><th>Created</th><th>Result / details</th></tr></thead><tbody>{jobs.map((job, index) => <tr key={job.id || index}><td><strong>@{job.username}</strong><small className="block-muted" title={job.reel_id}>{job.reel_id.slice(0, 8)}</small></td><td><Status status={job.status}/></td><td>{job.attempt_count}</td><td>{formatDateTime(job.created_at || null)}</td><td>{job.error_message ? <details className="job-error"><summary>View failure details</summary><p>{job.error_message}</p>{job.status === 'uncertain' && <p>Submission may have been accepted. A review is required before another attempt.</p>}</details> : job.status === 'no_speech' ? 'No audio or speech available' : formatDateTime(job.completed_at)}</td></tr>)}</tbody></table></div>}</div>}
    </>}
  </section>;
}

export function TranscriptionUsage({ overview, demo, compact = false }: { overview: TranscriptOverview; demo: boolean; compact?: boolean }) {
  const counts = overview.job_counts;
  const completeCounts = overview.job_counts_complete === true;
  const count = (...statuses: TranscriptStatus[]) => statuses.reduce((total, status) => total + (counts?.[status] ?? (completeCounts ? 0 : overview.jobs.filter(job => job.status === status).length)), 0);
  const attention = count('media_unavailable', 'failed', 'uncertain');
  const spent = overview.accounted_month_spend ?? overview.estimated_month_spend;
  const allocation = spent + overview.reserved_usd;
  const percentage = overview.monthly_budget_usd > 0 ? Math.max(0, Math.min(100, allocation / overview.monthly_budget_usd * 100)) : 100;
  const reached = allocation >= overview.monthly_budget_usd;
  const warning = overview.spending_warning === true || percentage >= (overview.budget_warning_pct ?? 80);
  const state = demo ? 'demo' : !overview.enabled ? 'disabled' : overview.paused ? 'paused' : overview.processing_ready !== true || count('uncertain') > 0 || reached ? 'attention' : 'active';
  const stateLabel = { demo: 'Synthetic demo', disabled: 'Disabled', paused: 'Paused', attention: reached ? 'Allowance reached' : overview.processing_ready === undefined ? 'Readiness unverified' : 'Needs attention', active: overview.phase === 'pilot' ? 'Pilot running' : 'Ready for transcript requests' }[state];
  const stateCopy = demo ? 'Transcription is disabled in this demo. No synthetic transcript text or paid calls are generated.' : !overview.enabled ? overview.processing_ready ? 'Setup is verified. New transcript requests are disabled; completed transcripts remain available.' : 'Disabled on server. Finish activation before new videos can be processed.' : overview.paused ? 'New transcription work is paused. You can still read and export completed transcripts.' : reached ? 'New paid work waits until allowance is available. Existing results stay readable.' : count('uncertain') > 0 ? 'A submission outcome needs review before more paid work can start.' : overview.processing_ready === undefined ? 'Processing readiness is unverified. Refresh status after the server setup is updated.' : overview.processing_ready === false ? 'Setup or spending checks need attention before new paid work can start.' : 'Only Reels requested with Get transcript are processed. Requested work can finish after you leave the page.';
  return <>
    <div className={`automation-state automation-state--${state}`} role="status"><span className="automation-state-dot"/><div><strong>{stateLabel}</strong>{(!compact || state === 'attention' || state === 'disabled') && <p>{stateCopy}</p>}</div></div>
    {compact && <div className="settings-usage-summary"><dl><div><dt>Used + reserved</dt><dd>{formatUsd(allocation)} <small>/ {formatUsd(overview.monthly_budget_usd)}</small></dd></div><div><dt>Pending holds</dt><dd>{formatUsd(overview.reserved_usd)}</dd></div><div><dt>Actual billed</dt><dd>{overview.actual_month_spend === null ? 'Unknown' : formatUsd(overview.actual_month_spend)}</dd></div></dl><details><summary>Billing details</summary><p className="helper-copy">Allowance includes provisional amounts until billing is reconciled. Reservations are not billed charges.</p></details></div>}
    {!compact && <><div className="automation-stats" aria-label={completeCounts ? 'Transcription totals' : 'Recent transcription totals'}><div><Clock3 size={17} aria-hidden="true"/><span>{completeCounts ? 'Queued' : 'Recent queued'}</span><strong>{formatNumber(count('queued', 'awaiting_media', 'budget_paused'))}</strong></div><div><Activity size={17} aria-hidden="true"/><span>{completeCounts ? 'In progress' : 'Recent in progress'}</span><strong>{formatNumber(count('submitting', 'processing'))}</strong></div><div><CheckCircle2 size={17} aria-hidden="true"/><span>{completeCounts ? 'Ready' : 'Recent ready'}</span><strong>{formatNumber(count('ready'))}</strong></div><div><AlertTriangle size={17} aria-hidden="true"/><span>{completeCounts ? 'Needs attention' : 'Recent attention'}</span><strong>{formatNumber(attention)}</strong></div></div>
    <div className="automation-spending-summary">
      <div className="allowance-progress"><div><span>Monthly allowance accounting</span><strong>{formatUsd(allocation)} <small>of {formatUsd(overview.monthly_budget_usd)}</small></strong></div><progress className={warning ? 'allowance-progress-warning' : ''} aria-label="Monthly transcription allowance used and reserved" max="100" value={percentage}/>{warning && !demo && <p className="spending-warning" role="status">{reached ? 'The monthly safety ceiling has been reached.' : 'Your configured spending warning threshold has been reached.'}</p>}</div>
      <dl className="transcript-usage"><div><dt>Allowance used this month</dt><dd>{formatUsd(spent)}</dd></div><div><dt>Reserved for pending work</dt><dd>{formatUsd(overview.reserved_usd)}</dd></div><div><dt>Actual speech charges</dt><dd>{overview.actual_month_spend === null ? 'Unknown' : formatUsd(overview.actual_month_spend)}</dd></div><div><dt>Processing mode</dt><dd>{overview.phase === 'automatic' ? 'On demand' : 'Pilot validation'}</dd></div></dl>
    </div>
    <p className="transcription-billing-note"><ShieldCheck size={15} aria-hidden="true"/>Allowance accounting and reservations are not billed charges. Actual speech cost remains unknown until authoritative billing is reconciled.</p></>}
  </>;
}
