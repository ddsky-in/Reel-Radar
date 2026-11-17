'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bookmark, Check, Clock3, Copy, Eye, Heart, Loader2, MessageCircle, Mic, Play, RefreshCw, TrendingUp, Users, Zap } from 'lucide-react';
import type { Reel, ReelDetail, ReelNeighbors, ReelQuery, TranscriptRequest } from '../lib/types';
import { api, errorMessage } from '../lib/client';
import { saveReel, useReelSavePending } from '../lib/reel-save';
import { formatCompact, formatDate, formatDateTime, formatNumber } from '../lib/format';
import { canonicalReelUrl } from '../lib/normalize';
import { reelQueryString } from '../lib/reel-filters';
import { processingMessage, reelOverview, transcriptEstimateLabel, transcriptIsPending, transcriptWordCount } from '../lib/reel-detail';
import { transcriptPlainText } from '../lib/transcript';
import { Avatar, Dialog, ErrorState, SourceLink, useResource, type Notify } from './ui';
import { Thumbnail } from './reel-thumbnail';
import { MetricValue, ReelCompletionButton } from './reels';
import { ProfileOutlierValue } from './profile-outlier';
import { TranscriptContent } from './transcript-viewer';

export function ReelNavigationButtons({ neighbors, onNavigate, disabled = false }: { neighbors?: ReelNeighbors | null; onNavigate?: (id: string) => void; disabled?: boolean }) {
  return <nav className="reel-detail-navigation" aria-label="Navigate current Reel list">
    {neighbors?.position != null && <span>{neighbors.position} / {neighbors.total}</span>}
    <button type="button" className="icon-button" aria-label="Previous Reel" title="Previous Reel in the current filtered list" disabled={disabled || !neighbors?.previous_id || !onNavigate} onClick={() => { if (neighbors?.previous_id) onNavigate?.(neighbors.previous_id); }}><ArrowLeft size={18}/></button>
    <button type="button" className="icon-button" aria-label="Next Reel" title="Next Reel in the current filtered list" disabled={disabled || !neighbors?.next_id || !onNavigate} onClick={() => { if (neighbors?.next_id) onNavigate?.(neighbors.next_id); }}><ArrowRight size={18}/></button>
  </nav>;
}

export function ReelDetailDialog({ reel, workspaceId, onSave, onClose, neighbors, onNavigate }: { reel: Reel; workspaceId: string; onSave: (reel: Reel) => void; onClose: () => void; neighbors?: ReelNeighbors; onNavigate?: (id: string) => void }) {
  return <ReelDetailView key={reel.id} reelId={reel.id} seed={reel} workspaceId={workspaceId} onSave={onSave} onBack={onClose} actions={<ReelNavigationButtons neighbors={neighbors} onNavigate={onNavigate}/>} dialog/>;
}

export function ReelDetailPage({ reelId, workspaceId, notify, onBack, listQuery, onNavigate }: { reelId: string; workspaceId: string; notify: Notify; onBack: () => void; listQuery?: ReelQuery | null; onNavigate?: (id: string) => void }) {
  const [revision, setRevision] = useState(0);
  const neighbors = useResource<ReelNeighbors>(listQuery && onNavigate ? `/api/workspaces/${encodeURIComponent(workspaceId)}/reels/${encodeURIComponent(reelId)}/neighbors?${reelQueryString(listQuery)}` : null, revision);
  const actions = <><ReelNavigationButtons neighbors={neighbors.data} disabled={neighbors.loading || Boolean(neighbors.error)} onNavigate={onNavigate}/>{neighbors.error && <button type="button" className="text-button" onClick={() => setRevision(value => value+1)}>Retry navigation</button>}</>;
  return <ReelDetailView reelId={reelId} workspaceId={workspaceId} notify={notify} onBack={onBack} actions={actions}/>;
}

function ReelDetailView({ reelId, seed, workspaceId, notify, onSave, onBack, actions, dialog = false }: { reelId: string; seed?: Reel; workspaceId: string; notify?: Notify; onSave?: (reel: Reel) => void; onBack: () => void; actions?: React.ReactNode; dialog?: boolean }) {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/reels/${encodeURIComponent(reelId)}`;
  const [revision, setRevision] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const saving = useReelSavePending(workspaceId, reelId);
  const [requestError, setRequestError] = useState<string | null>(null);
  const resource = useResource<ReelDetail>(path, revision);
  const detail = resource.error ? null : resource.data;
  const current = detail?.reel ?? seed;
  const controller = useRef<AbortController | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const request = useCallback(async () => {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setRequesting(true); setRequestError(null);
    try {
      const input: TranscriptRequest = detail?.processing.retry_attempt_id
        ? { retry_attempt_id: detail.processing.retry_attempt_id, accept_duplicate_charge: true } : {};
      await api<ReelDetail>(`${path}/transcript`, { method: 'POST', body: JSON.stringify(input), signal: abort.signal });
    } catch (error) {
      if (!abort.signal.aborted) setRequestError(errorMessage(error));
    } finally {
      controller.current = null;
      if (!abort.signal.aborted) setRequesting(false);
    }
  }, [path, detail]);

  useEffect(() => {
    if (!detail || !transcriptIsPending(detail.transcript.status) && detail.transcript.status !== 'uncertain') return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setRevision(value => value + 1);
    }, detail.processing.reason ? 15_000 : 5_000);
    return () => clearInterval(timer);
  }, [detail]);

  async function save(reel: Reel) {
    if (onSave) { onSave(reel); return; }
    try {
      if (!await saveReel(workspaceId, reel)) return;
      notify?.(reel.saved ? 'Removed from saved research.' : 'Saved to this workspace.');
    } catch (error) { notify?.(errorMessage(error), 'error'); }
  }

  const title = current?.caption_preview.trim() || (current ? `Reel by @${current.username}` : 'Reel research');
  const content = current ? <ReelResearchPanels reel={current} workspaceId={workspaceId} detail={detail} loading={resource.loading} error={resource.error} retry={() => setRevision(value => value + 1)} requesting={requesting} requestError={requestError} request={request} videoRef={video} onSave={reel => void save(reel)} saving={saving}/>
    : resource.loading ? <div className="reel-research-loading" role="status"><Loader2 size={24} className="spin"/>Loading Reel details…</div>
    : <ErrorState message={resource.error ?? 'This Reel is unavailable in the selected workspace.'} retry={() => setRevision(value => value + 1)}/>;
  if (dialog) return <Dialog title={title} subtitle={current ? `@${current.username} · Reel research` : undefined} onClose={onBack} actions={actions} wide>{content}</Dialog>;
  return <article className="reel-research-page">
    <button type="button" className="reel-research-back" onClick={onBack}><ArrowLeft size={16}/>Back to research</button>
    <header className="reel-research-heading"><h1 title={title}>{title}</h1>{actions}</header>
    {content}
  </article>;
}

export function ReelResearchPanels({ reel: current, workspaceId, detail, loading, error, retry, requesting = false, requestError = null, request, videoRef, onSave, saving = false }: { reel: Reel; workspaceId?: string; detail: ReelDetail | null; loading: boolean; error?: string | null; retry: () => void; requesting?: boolean; requestError?: string | null; request: () => Promise<void>; videoRef: React.RefObject<HTMLVideoElement | null>; onSave: (reel: Reel) => void; saving?: boolean }) {
  const [activeSection, setActiveSection] = useState('transcript');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const pending = detail && transcriptIsPending(detail.transcript.status);
  const idle = detail?.transcript.status === 'not_requested';
  const reason = detail ? processingMessage(detail.processing.reason, detail.processing.priority) : null;
  const providerBlocked = detail?.processing.reason === 'provider_review_required';
  const priorityQueued = detail?.processing.priority === 'high' && Boolean(pending);
  const uncertainRetry = Boolean(detail?.processing.retry_attempt_id);
  const requestLabel = requesting ? 'Requesting…' : priorityQueued ? 'Transcript requested' : uncertainRetry || detail && ['failed','media_unavailable'].includes(detail.transcript.status) ? 'Retry transcript' : 'Get transcript';
  const estimate = detail ? transcriptEstimateLabel(detail.processing.estimate) : null;
  const transcript = detail ? transcriptPlainText(detail.transcript) : null;
  const overview = detail ? reelOverview(detail) : null;
  const caption = !error ? detail?.caption_full : null;
  function seek(seconds: number) {
    if (!videoRef.current || !Number.isFinite(videoRef.current.duration)) return;
    videoRef.current.currentTime = Math.min(seconds, videoRef.current.duration);
    void videoRef.current.play().catch(() => {});
  }
  return <div className="reel-detail-layout">
    <aside className="reel-detail-preview" aria-label="Video and performance">
      <ReelPlayback key={detail?.media.urls.join('|') ?? 'loading'} reel={current} detail={detail} loading={loading} videoRef={videoRef}/>
      <div className="reel-detail-creator"><Avatar username={current.username} url={current.avatar_url}/><div><strong>@{current.username}</strong><span title={current.published_at_basis === 'assumed_Asia/Kolkata' ? 'Source publication date interpreted as IST' : formatDateTime(current.published_at)}>{current.published_at ? formatDate(current.published_at) : 'Publication date unverified'}</span></div></div>
      <dl className="reel-detail-stats">
        <div className="reel-stat-primary"><dt><Users size={14} aria-hidden="true"/>Followers</dt><dd title={`${formatNumber(current.followers_count)} followers · Captured ${formatDateTime(current.follower_captured_at)}`}>{formatCompact(current.followers_count)}</dd></div>
        <div className="reel-stat-primary"><dt><TrendingUp size={14} aria-hidden="true"/>Outlier score</dt><dd><MetricValue value={current.follower_outlier_score} kind="outlier"/></dd></div>
        <div className="reel-stat-primary"><dt><Zap size={14} aria-hidden="true"/>Engagement rate</dt><dd><MetricValue value={current.engagement_rate_pct} kind="engagement"/></dd></div>
        <div className="reel-stat-primary"><dt><TrendingUp size={14} aria-hidden="true"/>Profile outlier</dt><dd><ProfileOutlierValue reel={current}/></dd></div>
        <div><dt><Eye size={13}/>Views</dt><dd><MetricValue value={current.latest_views} state={current.views_state}/></dd></div>
        <div><dt><Heart size={13}/>Likes</dt><dd><MetricValue value={current.latest_likes} state={current.likes_state}/></dd></div>
        <div><dt><MessageCircle size={13}/>Comments</dt><dd><MetricValue value={current.latest_comments} state={current.comments_state}/></dd></div>
      </dl>
      <button type="button" className="button button-accent reel-detail-save" aria-pressed={current.saved} aria-busy={saving} disabled={saving} onClick={() => onSave(current)}><Bookmark size={16} fill={current.saved ? 'currentColor' : 'none'}/> {current.saved ? 'Saved to research' : 'Save to research'}</button>
      {current.saved && workspaceId && <ReelCompletionButton key={current.id} reel={current} workspaceId={workspaceId}/>}
      <div className="reel-detail-source"><SourceLink url={current.reel_url} label="Open original Reel"/></div>
      {current.reel_url && <p className="reel-detail-source-note">Playback unavailable? View it on Instagram.</p>}
    </aside>
    <div className="reel-detail-info">
      <section className="reel-detail-summary" id="reel-summary" aria-label="Reel summary"><div className="reel-detail-section-heading"><h2>Summary</h2>{overview && <span className="reel-summary-source">{overview.source}</span>}</div><p>{loading ? 'Loading summary…' : error ? 'Summary could not be loaded.' : overview?.text ?? 'A summary will be available when transcript or caption text is recorded.'}</p></section>
      <nav className="reel-research-tabs" aria-label="Reel research sections"><a href="#reel-transcript" aria-current={activeSection === 'transcript' ? 'location' : undefined} onClick={() => setActiveSection('transcript')}><Mic size={16}/>Transcript</a><a href="#reel-caption" aria-current={activeSection === 'caption' ? 'location' : undefined} onClick={() => setActiveSection('caption')}><MessageCircle size={16}/>Caption</a><a href="#reel-metadata" aria-current={activeSection === 'details' ? 'location' : undefined} onClick={() => { setActiveSection('details'); setDetailsOpen(true); }}><Clock3 size={16}/>Details</a></nav>
      <section className="reel-detail-transcript reel-research-panel" id="reel-transcript" aria-label="Reel transcript"><div className="reel-detail-section-heading"><div><Mic size={19}/><h2>Transcript</h2>{transcript && <span className="reel-word-count">{transcriptWordCount(transcript)} words</span>}</div>{!loading && !error && (detail?.processing.request_allowed || uncertainRetry) && <button type="button" className="button button-secondary transcript-header-action" aria-describedby={uncertainRetry ? 'transcript-retry-notice' : undefined} disabled={requesting || priorityQueued} onClick={() => void request()}>{requesting ? <Loader2 size={14} className="spin"/> : priorityQueued ? <Check size={14}/> : <RefreshCw size={14}/>}<span>{requestLabel}</span></button>}</div>
        <div className="reel-research-panel-body">
          {loading ? <p className="transcript-feedback" role="status"><Loader2 size={15} className="spin"/>Loading Reel details…</p> : error ? <ErrorState message={error} retry={retry}/> : detail && <>
            {(requesting || pending) && <div className="reel-transcript-progress" role="status"><div>{detail.processing.reason ? <Clock3 size={15}/> : <Loader2 size={15} className="spin"/>}<strong>{requesting ? 'Requesting transcript…' : providerBlocked ? 'Blocked by provider review' : detail.transcript.status === 'awaiting_media' ? 'Preparing video & audio' : detail.transcript.status === 'processing' ? 'Processing transcript' : detail.transcript.status === 'submitting' ? 'Starting transcription' : priorityQueued ? 'Waiting for transcription' : detail.transcript.status === 'budget_paused' ? 'Waiting for budget' : 'Transcript queued'}</strong></div><p>{reason ?? estimate ?? 'Your transcript will appear here when ready.'}</p>{detail.processing.queue_position != null && <p>Queue position: {detail.processing.queue_position}{detail.processing.retry_after_seconds ? ` · Retry eligible in about ${detail.processing.retry_after_seconds} seconds` : ''}</p>}</div>}
            {idle && !requesting && <p className="helper-copy" role="status">{reason ?? 'Turn this Reel’s audio into text.'}</p>}
            {uncertainRetry && <p id="transcript-retry-notice" className="helper-copy" role="status">The previous request’s result is unknown. Retry starts a new priority request and may incur another charge. Your spending limit still applies.</p>}
            {!idle && !pending && !requesting && <TranscriptContent transcript={detail.transcript} reelId={current.id} onSeek={detail.media.urls.length ? seek : undefined} statusMessage={uncertainRetry ? '' : reason ?? undefined} compact/>}
          </>}
          {requestError && <div className="transcript-feedback" role="alert"><p className="inline-error">{requestError}</p><button type="button" className="button button-secondary" disabled={requesting} onClick={() => void request()}>Retry request</button></div>}
        </div>
      </section>
      <section className="reel-detail-caption reel-research-panel" id="reel-caption" aria-label="Reel caption">
        <div className="reel-detail-section-heading"><div><MessageCircle size={19}/><h2>Caption</h2></div><CopyCaption key={caption} text={loading ? '' : caption ?? ''}/></div>
        <div className="reel-research-panel-body">
          {loading ? <p role="status">Loading full caption…</p>
            : error ? <p role="status">Caption could not be loaded. Refresh Reel details to try again.</p>
            : caption != null ? <p>{caption.trim() ? caption : 'This Reel has no caption.'}</p>
            : <><p>Full caption has not been collected for this Reel yet.</p>{current.reel_url && <p className="reel-caption-limited"><SourceLink url={current.reel_url} label="Read the full caption on Instagram"/></p>}</>}
        </div>
      </section>
      <details className="reel-detail-metadata" id="reel-metadata" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}><summary>More details</summary><dl><div><dt>Duration</dt><dd>{current.duration_seconds === null ? 'Not recorded' : `${current.duration_seconds} seconds`}</dd></div><div><dt>Stats updated</dt><dd>{formatDateTime(current.latest_fetched_at)}</dd></div><div><dt>First seen</dt><dd>{formatDateTime(current.first_seen_at)}</dd></div><div><dt>Creator status</dt><dd>{current.creator_status}</dd></div>{!current.published_at && <div><dt>Source date</dt><dd>{current.published_at_raw ?? 'Not recorded'} · timezone unverified</dd></div>}{current.note && <div><dt>Note</dt><dd>{current.note}</dd></div>}{current.tags.length > 0 && <div><dt>Tags</dt><dd>{current.tags.join(', ')}</dd></div>}</dl></details>
    </div>
  </div>;
}

function CopyCaption({ text }: { text: string }) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setFeedback('Caption copied.'); }
    catch { setCopied(false); setFeedback('Could not copy. Select the caption text to copy it.'); }
  }
  return <div className="reel-caption-copy">{feedback && <span role="status">{feedback}</span>}<button type="button" className="icon-button" aria-label="Copy caption" disabled={!text} onClick={() => void copy()}>{copied ? <Check size={15}/> : <Copy size={15}/>}</button></div>;
}

export function ReelPlayback({ reel, detail, loading, videoRef }: { reel: Reel; detail: ReelDetail | null; loading: boolean; videoRef: React.RefObject<HTMLVideoElement | null> }) {
  const [index, setIndex] = useState(0);
  const [embedded, setEmbedded] = useState(false);
  const source = detail?.media.urls[index];
  const original = canonicalReelUrl(reel.reel_url);
  const synthetic = reel.provider.startsWith('mock') || detail?.processing.reason === 'demo';
  if (source) return <div className="reel-detail-player"><video key={source} src={source} ref={videoRef} controls playsInline preload="metadata" aria-label={`Video for Reel by @${reel.username}`} onError={() => setIndex(value => value + 1)}>Your browser does not support video playback.</video></div>;
  if ((embedded || detail && !loading) && original && !synthetic) return <div className="reel-detail-embed"><iframe src={`${original.url}embed/`} title={`Original Instagram Reel by @${reel.username}`} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" referrerPolicy="no-referrer" allowFullScreen/></div>;
  return <div className="reel-detail-player reel-detail-player-empty"><Thumbnail reel={reel}/><div className="reel-playback-notice">{loading ? <><Loader2 size={22} className="spin"/><span>Loading video…</span></> : <><Play size={22}/><span>{synthetic ? 'Synthetic Reel preview' : index ? 'Stored video link is unavailable' : 'No playable video stored yet'}</span>{original && !synthetic && <button type="button" className="button button-secondary" onClick={() => setEmbedded(true)}>Load Instagram player</button>}</>}</div></div>;
}

