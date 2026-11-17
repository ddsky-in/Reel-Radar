'use client';

import Link from 'next/link';
import { useContext, useState } from 'react';
import { ArrowUpRight, Bookmark, Check, Circle, Eye, FileText, Heart, MessageCircle } from 'lucide-react';
import type { MetricState, Reel } from '../lib/types';
import { formatCompact, formatDate, formatDateTime, formatNumber, formatPercent, formatScore } from '../lib/format';
import { isStale, qualifiesEngagement, qualifiesOutlier } from '../lib/metrics';
import { setReelCompletion, useReelSavePending } from '../lib/reel-save';
import { errorMessage } from '../lib/client';
import { Avatar, SourceLink } from './ui';
import { Thumbnail } from './reel-thumbnail';
import { ReelDetailDialog } from './reel-detail';
import { ReelHrefContext, ReelListContext, ReelNavigationContext } from './reel-navigation';
import { ReelDownloadButton } from './reel-download-button';
import { ReelPreviewButton } from './reel-preview-button';
import { ProfileOutlierValue } from './profile-outlier';
export { Thumbnail } from './reel-thumbnail';

function displayDate(reel: Reel): string {
  return reel.published_at === null ? 'Date unverified' : formatDate(reel.published_at);
}

function publicationDetails(reel: Reel): string {
  if (reel.published_at === null) return `Raw publication date: ${reel.published_at_raw ?? 'Not recorded'}. Timezone unverified.`;
  const basis = reel.published_at_basis === 'assumed_Asia/Kolkata' ? ' Timezone-less source interpreted as IST per your setting.' : '';
  return `Uploaded: ${formatDateTime(reel.published_at)}.${basis}`;
}

export function MetricValue({ value, kind, state }: { value: number | null; kind?: 'engagement' | 'outlier'; state?: MetricState }) {
  const highlight = kind === 'engagement' ? qualifiesEngagement(value) : kind === 'outlier' ? qualifiesOutlier(value) : false;
  const text = value === null && state === 'hidden' ? 'Hidden' : value === null && state === 'not_fetched' ? 'Not fetched' : kind === 'engagement' ? formatPercent(value) : kind === 'outlier' ? formatScore(value) : formatCompact(value);
  const tooltip = kind === 'outlier' ? `Follower-based score: ${value === null ? 'N/A' : value.toFixed(4) + 'x'}. (Views + likes + comments) / captured followers.` : kind === 'engagement' ? `Views-based engagement: ${value === null ? 'N/A' : value.toFixed(4) + '%'}. (Likes + comments) / views × 100.` : value === null ? (state ?? 'Unavailable').replaceAll('_', ' ') : formatNumber(value);
  return <span className={`metric-value ${highlight ? 'metric-highlight' : ''} ${value === null ? 'metric-unknown' : ''}`} title={tooltip} tabIndex={0} aria-label={tooltip}>{text}</span>;
}

function ReelSaveButton({ reel, workspaceId, onSave, compact = false }: { reel: Reel; workspaceId: string; onSave: (reel: Reel) => void; compact?: boolean }) {
  const saving = useReelSavePending(workspaceId, reel.id);
  return <button type="button" className={`${compact ? 'bookmark-button' : 'icon-button'} reel-save-button ${reel.saved ? 'is-saved' : ''}`} title={saving ? 'Saving change…' : reel.saved ? 'Unsave Reel' : 'Save Reel'} aria-label={`${reel.saved ? 'Unsave' : 'Save'} Reel by ${reel.username}`} aria-pressed={reel.saved} aria-busy={saving} disabled={saving} onClick={() => onSave(reel)}><Bookmark size={compact ? 15 : 17} aria-hidden="true" fill={reel.saved ? 'currentColor' : 'none'}/></button>;
}

export function ReelCard({ reel, workspaceId, onSave }: { reel: Reel; workspaceId: string; onSave: (reel: Reel) => void }) {
  const [open, setOpen] = useState(false);
  const navigate = useContext(ReelNavigationContext);
  const getHref = useContext(ReelHrefContext);
  const list = useContext(ReelListContext);
  const href = getHref?.(reel, workspaceId, list);
  const openDetail = () => navigate ? navigate(reel, workspaceId, list) : setOpen(true);
  return <><article className="reel-card">
    {href ? <Link href={href} prefetch={false} className="reel-card-open" aria-label={`Open Reel by @${reel.username}`} onNavigate={event => { if (navigate) { event.preventDefault(); openDetail(); } }}/>
      : <button type="button" className="reel-card-open" aria-label={`Open Reel by @${reel.username}`} aria-haspopup={navigate ? undefined : 'dialog'} onClick={openDetail}/>}
    <div className="reel-visual">
      <Thumbnail reel={reel}/>
      <div className="reel-media-actions"><ReelDownloadButton reel={reel} workspaceId={workspaceId}/><ReelPreviewButton reel={reel} workspaceId={workspaceId}/></div>
      {reel.saved && <div className="reel-completion-overlay"><ReelCompletionButton reel={reel} workspaceId={workspaceId}/></div>}
      <div className="reel-thumbnail-actions">
        <SourceLink url={reel.reel_url} label={`Open Instagram Reel by @${reel.username} (opens in a new tab)`} iconOnly/>
        <ReelSaveButton reel={reel} workspaceId={workspaceId} onSave={onSave} compact/>
      </div>
    </div>
    <div className="reel-card-body">
      <div className="reel-creator">
        <Avatar username={reel.username} url={reel.avatar_url}/>
        <div><strong title={`@${reel.username}`}>@{reel.username}</strong><span title={publicationDetails(reel)}>{displayDate(reel)}</span></div>
      </div>
      <p className="reel-caption" title={reel.caption_preview}>{reel.caption_preview || 'No caption available'}</p>
      <div className="reel-counts">
        <span><Eye size={13}/><MetricValue value={reel.latest_views} state={reel.views_state}/></span>
        <span><Heart size={13}/><MetricValue value={reel.latest_likes} state={reel.likes_state}/></span>
        <span><MessageCircle size={13}/><MetricValue value={reel.latest_comments} state={reel.comments_state}/></span>
      </div>
      <div className="reel-scores">
        <div><span>Engagement</span><MetricValue value={reel.engagement_rate_pct} kind="engagement"/></div>
        <div title={`Followers: ${formatNumber(reel.followers_count)} · ${formatDateTime(reel.follower_captured_at)}`}><span>Follower outlier</span><MetricValue value={reel.follower_outlier_score} kind="outlier"/></div>
        <div><span>Profile outlier</span><ProfileOutlierValue reel={reel}/></div>
      </div>
      {href && <Link href={href} prefetch={false} className="reel-detail-link" aria-label={`Open reel details by @${reel.username}`} onNavigate={event => { if (navigate) { event.preventDefault(); openDetail(); } }}>Open reel<ArrowUpRight size={14} aria-hidden="true"/></Link>}
    </div>
  </article>{open && <ReelDetailDialog reel={reel} workspaceId={workspaceId} onSave={onSave} onClose={() => setOpen(false)}/>}</>;
}

export function ReelTable({ reels, workspaceId, onSave }: { reels: Reel[]; workspaceId: string; onSave: (reel: Reel) => void }) {
  const [selected, setSelected] = useState<Reel | null>(null);
  const navigate = useContext(ReelNavigationContext);
  const getHref = useContext(ReelHrefContext);
  const list = useContext(ReelListContext);
  const openDetail = (reel: Reel) => navigate ? navigate(reel, workspaceId, list) : setSelected(reel);
  const selectedIndex = selected ? reels.findIndex(reel => reel.id === selected.id) : -1;
  return <><div className="table-scroll"><table className="data-table reel-table">
    <thead><tr><th>Reel / creator</th><th>Published</th><th>Views</th><th>Likes</th><th>Comments</th><th>Engagement</th><th>Follower outlier</th><th>Profile outlier</th><th>Freshness / status</th><th><span className="sr-only">Actions</span></th></tr></thead>
    <tbody>{reels.map(reel => <tr key={reel.id}>
      <td>{getHref ? <Link href={getHref(reel, workspaceId, list)} prefetch={false} className="table-reel table-reel-open" aria-label={`Open Reel by @${reel.username}`} onNavigate={event => { if (navigate) { event.preventDefault(); openDetail(reel); } }}><Thumbnail reel={reel} compact/><span><strong>@{reel.username}</strong><span title={reel.caption_preview}>{reel.caption_preview}</span><small>Open reel ↗</small></span></Link>
        : <button type="button" className="table-reel table-reel-open" aria-label={`Open Reel by @${reel.username}`} aria-haspopup={navigate ? undefined : 'dialog'} onClick={() => openDetail(reel)}><Thumbnail reel={reel} compact/><span><strong>@{reel.username}</strong><span title={reel.caption_preview}>{reel.caption_preview}</span></span></button>}</td>
      <td title={publicationDetails(reel)}>{displayDate(reel)}</td>
      <td><MetricValue value={reel.latest_views} state={reel.views_state}/></td>
      <td><MetricValue value={reel.latest_likes} state={reel.likes_state}/></td>
      <td><MetricValue value={reel.latest_comments} state={reel.comments_state}/></td>
      <td><MetricValue value={reel.engagement_rate_pct} kind="engagement"/></td>
      <td title={`Followers: ${formatNumber(reel.followers_count)} · ${formatDateTime(reel.follower_captured_at)}`}><MetricValue value={reel.follower_outlier_score} kind="outlier"/></td>
      <td><ProfileOutlierValue reel={reel}/></td>
      <td title={formatDateTime(reel.latest_fetched_at)}><span className={isStale(reel.latest_fetched_at) ? 'stale-label' : 'fresh-label'}>{isStale(reel.latest_fetched_at) ? 'Stale' : 'Fresh'}</span><small className="block-muted">{reel.creator_status}</small></td>
      <td><div className="table-actions"><ReelSaveButton reel={reel} workspaceId={workspaceId} onSave={onSave}/>{reel.saved && <ReelCompletionButton reel={reel} workspaceId={workspaceId}/>}<button type="button" className="button button-secondary transcript-button" aria-haspopup={navigate ? undefined : 'dialog'} onClick={() => openDetail(reel)}><FileText size={14}/>Transcript</button><SourceLink url={reel.reel_url}/></div></td>
    </tr>)}</tbody>
  </table></div>{selected && <ReelDetailDialog reel={reels.find(reel => reel.id === selected.id) ?? selected} workspaceId={workspaceId} onSave={onSave} onClose={() => setSelected(null)} neighbors={{ previous_id: selectedIndex > 0 ? reels[selectedIndex-1].id : null, next_id: selectedIndex >= 0 ? reels[selectedIndex+1]?.id ?? null : null, position: selectedIndex >= 0 ? selectedIndex+1 : null, total: reels.length }} onNavigate={id => { const next = reels.find(reel => reel.id === id); if (next) setSelected(next); }}/>}</>;
}

export function ReelCompletionButton({ reel, workspaceId }: { reel: Reel; workspaceId: string }) {
  const busy = useReelSavePending(workspaceId, reel.id), done = reel.completion_status === 'done';
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    setError(null);
    try { await setReelCompletion(workspaceId, reel); } catch (failure) { setError(errorMessage(failure)); }
  }
  return <span className="reel-completion-control"><button type="button" className={`button button-secondary reel-completion-button${done ? ' is-done' : ''}`} aria-label={done ? 'Mark Reel as pending' : 'Mark Reel as completed'} aria-pressed={done} disabled={busy || !reel.saved} aria-busy={busy} onClick={() => void toggle()}>{done ? <Check size={14}/> : <Circle size={14}/>}<span aria-live="polite">{done ? 'Done' : 'Mark done'}</span></button>{error && <span className="inline-error" role="alert">{error}</span>}</span>;
}
