'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Activity, ArrowRight, ArrowUpRight, Bookmark, ChevronDown, Clock3, Film, TrendingUp, Users } from 'lucide-react';
import type { Bootstrap, Overview, Reel } from '@/lib/types';
import { errorMessage } from '@/lib/client';
import { saveReel, useReelSavePending } from '@/lib/reel-save';
import { appPath, reelDetailPath } from '@/lib/app-navigation';
import { formatCompact, formatDate, formatDateTime, formatNumber, formatPercent, formatScore, formatUsd } from '@/lib/format';
import { Avatar, Empty, ErrorState, Skeleton, useResource, type Notify } from './ui';
import { MetricValue, Thumbnail } from './reels';

export function Dashboard({ workspaceId, bootstrap, notify, revision }: { workspaceId: string; bootstrap: Bootstrap; notify: Notify; revision: number }) {
  const [localRevision, setLocalRevision] = useState(0);
  const resource = useResource<Overview>(`/api/workspaces/${encodeURIComponent(workspaceId)}/overview`, revision + localRevision);
  const overview = resource.data;
  const recentReels = overview?.recent.slice(0, 5) ?? [];

  async function save(reel: Reel) {
    try {
      if (!await saveReel(workspaceId, reel)) return;
      notify(reel.saved ? 'Removed from saved research.' : 'Saved to this workspace.');
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  }

  return <div className="dashboard-page">
    <div className="dashboard-heading">
      <div>
        <h1>Dashboard</h1>
        <p className="dashboard-updated"><Clock3 size={14} aria-hidden="true"/>{overview ? overview.last_refresh ? `Last refresh ${formatDateTime(overview.last_refresh)}` : 'No collection yet' : 'Your workspace at a glance'}</p>
      </div>
      <Link className="button button-accent" href={appPath('reels')}>Explore Reels<ArrowUpRight size={16} aria-hidden="true"/></Link>
    </div>

    {resource.error && overview && <p className="inline-error" role="status">Background update failed: {resource.error} <button className="text-link" onClick={() => setLocalRevision(value => value + 1)}>Retry</button></p>}
    {resource.error && !overview ? <ErrorState message={resource.error} retry={() => setLocalRevision(value => value + 1)}/> : !overview ? <Skeleton/> : <>
      <dl className="dashboard-metrics" aria-label="Workspace summary">
        <DashboardStat label="Active creators" value={formatNumber(overview.active_competitors)} icon={<Users size={17}/>} context="In this workspace"/>
        <DashboardStat label="Reels tracked" value={formatCompact(overview.tracked_reels)} icon={<Film size={17}/>} context="Across your creators"/>
        <DashboardStat label="10x+ outliers" value={formatNumber(overview.outliers)} icon={<TrendingUp size={17}/>} context="Based on captured followers"/>
        <DashboardStat label="Avg. engagement" value={formatPercent(overview.average_engagement)} icon={<Activity size={17}/>} context="Views-based · known metrics"/>
      </dl>

      <div className="dashboard-research-grid">
        <section className="dashboard-panel dashboard-recent" aria-labelledby="dashboard-recent-title">
          <div className="dashboard-panel-heading">
            <div><h2 id="dashboard-recent-title">Recent Reels</h2><p>Latest posts from your creators</p></div>
            <Link href={appPath('reels')} className="text-link">View all<ArrowUpRight size={14} aria-hidden="true"/></Link>
          </div>
          {recentReels.length ? <ul className="dashboard-reel-list">
            {recentReels.map(reel => <li className="dashboard-reel-row" key={reel.id}>
              <Link className="dashboard-reel-link" href={reelDetailPath(reel.id, workspaceId, appPath('overview'))}>
                <Thumbnail reel={reel} compact/>
                <div className="dashboard-reel-copy">
                  <strong title={reel.caption_preview}>{reel.caption_preview || `Reel by @${reel.username}`}</strong>
                  <span className="dashboard-reel-meta"><span title={`@${reel.username}`}>@{reel.username}</span><span aria-hidden="true">·</span>{reel.published_at ? <time dateTime={reel.published_at} title={formatDateTime(reel.published_at)}>{formatDate(reel.published_at)}</time> : <span>Date unverified</span>}</span>
                </div>
              </Link>
              <dl className="dashboard-reel-metrics">
                <div><dt>Views</dt><dd><MetricValue value={reel.latest_views} state={reel.views_state}/></dd></div>
                <div><dt>Outlier</dt><dd><MetricValue value={reel.follower_outlier_score} kind="outlier"/></dd></div>
              </dl>
              <DashboardSaveButton reel={reel} workspaceId={workspaceId} onSave={save}/>
            </li>)}
          </ul> : <Empty
            title={overview.tracked_reels > 0 ? 'No recent Reels available' : overview.leaderboard.length ? 'No Reels collected yet' : 'Your research starts here'}
            description={overview.tracked_reels > 0 ? 'Open the explorer to browse this workspace’s collected Reels.' : overview.leaderboard.length ? 'Check job activity to see collection progress for your creators.' : 'Add creators to start building your Reel collection.'}
            action={<Link href={appPath(overview.tracked_reels > 0 ? 'reels' : overview.leaderboard.length ? 'jobs' : 'competitors')} className="button button-secondary">{overview.tracked_reels > 0 ? 'Explore Reels' : overview.leaderboard.length ? 'View job activity' : 'Add creators'}<ArrowRight size={15}/></Link>}
          />}
        </section>

        <section className="dashboard-panel dashboard-creators" aria-labelledby="dashboard-creators-title">
          <div className="dashboard-panel-heading">
            <div><h2 id="dashboard-creators-title">Leading creators</h2><p>Ranked by 10x+ Reels</p></div>
            <Link href={appPath('competitors')} className="text-link" aria-label="View all creators"><ArrowUpRight size={16} aria-hidden="true"/></Link>
          </div>
          {overview.leaderboard.length ? <>
            <ol className="dashboard-creator-list" aria-label="Creator ranking">
              {overview.leaderboard.slice(0, 5).map((entry, index) => <li key={entry.creator.id}>
                <Link href={`${appPath('reels')}?creator_id=${encodeURIComponent(entry.creator.id)}`} className="dashboard-creator-link">
                  <span className="dashboard-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  <Avatar username={entry.creator.username} url={entry.creator.avatar_url} index={index}/>
                  <span className="dashboard-creator-name"><strong title={entry.creator.display_name || entry.creator.username}>{entry.creator.display_name || `@${entry.creator.username}`}</strong><span title={`${formatNumber(entry.creator.followers_count)} captured followers`}>{entry.creator.display_name ? `@${entry.creator.username}` : `${formatCompact(entry.creator.followers_count)} followers`}</span></span>
                  <span className="dashboard-creator-score"><strong>{formatNumber(entry.outliers)}<span className="sr-only"> Reels at 10x or above</span></strong><span title="Best follower-based outlier score">{formatScore(entry.best_score)} best</span></span>
                </Link>
              </li>)}
            </ol>
            <Link className="dashboard-panel-footer" href={appPath('reels')}>Browse Reels<ArrowRight size={15} aria-hidden="true"/></Link>
          </> : <Empty title="No creator activity yet" description="Your creators will appear here as their Reels are collected." action={<Link href={appPath('competitors')} className="text-link">Manage creators<ArrowRight size={14}/></Link>}/>}
        </section>
      </div>

      <DashboardActivity bootstrap={bootstrap} overview={overview}/>
      <p className="dashboard-snapshot-note">Metrics reflect collected snapshots. All times are in IST.</p>
    </>}
  </div>;
}

function DashboardSaveButton({ reel, workspaceId, onSave }: { reel: Reel; workspaceId: string; onSave: (reel: Reel) => void }) {
  const saving = useReelSavePending(workspaceId, reel.id);
  return <button type="button" className={`icon-button dashboard-reel-save ${reel.saved ? 'is-saved' : ''}`} aria-label={`${reel.saved ? 'Unsave' : 'Save'} Reel by @${reel.username}`} aria-pressed={reel.saved} aria-busy={saving} disabled={saving} onClick={() => onSave(reel)}><Bookmark size={17} fill={reel.saved ? 'currentColor' : 'none'} aria-hidden="true"/></button>;
}

function DashboardStat({ label, value, context, icon }: { label: string; value: string; context: string; icon: ReactNode }) {
  return <div><dt>{label}<span aria-hidden="true">{icon}</span></dt><dd><strong>{value}</strong><span>{context}</span></dd></div>;
}

function DashboardActivity({ bootstrap, overview }: { bootstrap: Bootstrap; overview: Overview }) {
  const processing = bootstrap.jobs.filter(job => ['pending', 'dispatching', 'running', 'processing'].includes(job.status)).length;
  const failed = bootstrap.jobs.filter(job => job.status === 'failed' || job.status === 'partial').length;
  const collection = bootstrap.mode === 'demo' ? 'Synthetic demo' : !bootstrap.settings.scraping_enabled ? 'Collection disabled' : bootstrap.settings.paused ? 'Auto-refresh paused' : 'Collection enabled';
  const billed = bootstrap.usage.actual_month_spend == null ? 'Unknown' : formatUsd(bootstrap.usage.actual_month_spend);

  return <details className="dashboard-activity">
    <summary>
      <span className="dashboard-activity-title"><Activity size={17} aria-hidden="true"/><strong>Collection &amp; usage</strong><span className="dashboard-collection-label">{collection}</span></span>
      <span className="dashboard-activity-summary"><span>Actual billed <strong>{billed}</strong></span><ChevronDown size={17} className="dashboard-disclosure-icon" aria-hidden="true"/></span>
    </summary>
    <div className="dashboard-activity-details">
      <section aria-labelledby="dashboard-collection-title">
        <h3 id="dashboard-collection-title">Collection status</h3>
        <dl>
          <div><dt>Last successful refresh</dt><dd>{formatDateTime(overview.last_refresh)}</dd></div>
          <div><dt>Stale snapshots</dt><dd>{formatNumber(overview.stale_reels)} Reels</dd></div>
          <div><dt>Automatic refresh setting</dt><dd>{bootstrap.settings.paused ? 'Paused' : 'Not paused'}</dd></div>
          <div><dt>Recent account jobs</dt><dd>{processing} processing · {failed} failed / partial</dd></div>
        </dl>
        <p>Job counts cover recent activity across all workspaces.</p>
        <Link href={appPath('jobs')} className="text-link">View job activity<ArrowUpRight size={14} aria-hidden="true"/></Link>
      </section>
      <section aria-labelledby="dashboard-usage-title">
        <h3 id="dashboard-usage-title">Monthly usage</h3>
        <dl>
          <div><dt>Actual billed</dt><dd>{billed}</dd></div>
          <div><dt>Budget cap</dt><dd>{formatUsd(bootstrap.settings.monthly_budget_usd)}</dd></div>
          <div><dt>Reserved for pending work</dt><dd>{formatUsd(bootstrap.usage.reserved_usd)}</dd></div>
          <div><dt>Provider balance</dt><dd>{bootstrap.usage.provider_balance_usd == null ? 'Unknown' : formatUsd(bootstrap.usage.provider_balance_usd)}</dd></div>
        </dl>
        <p>Actual charges stay unknown until provider billing is reconciled.</p>
        <Link href={appPath('settings')} className="text-link">Manage spending<ArrowUpRight size={14} aria-hidden="true"/></Link>
      </section>
    </div>
  </details>;
}
